// Bolsillo mobile UI: list apps, create from a template, chat with Claude, run and preview.
const $ = (id) => document.getElementById(id);
const state = { project: null, busy: false };

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
}

function toast(msg) { alert(msg); }

// Minimal, safe markdown for Claude's replies: escapes HTML first, then **bold**, *italic*, `code`, lists.
function md(text) {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/^#{1,6} (.+)$/gm, '<b>$1</b>')
    .replace(/^[-*] (.+)$/gm, '• $1');
}

// ---------------- Home ----------------
async function showHome() {
  state.project = null;
  $('project').hidden = true;
  $('home').hidden = false;
  history.replaceState(null, '', '#');

  const [projects, templates, info] = await Promise.all([api('/projects'), api('/templates'), api('/info')]);
  const phone = info.device?.some((d) => d.available);
  $('status').textContent = info.claude
    ? `Claude Code ${info.claude.split(' ')[0]} · ${phone ? 'móvil conectado 📱' : 'sin acceso al hardware del móvil'}`
    : '⚠️ Claude Code no está instalado o no has iniciado sesión';

  const list = $('projects');
  list.replaceChildren();
  for (const p of projects) {
    list.append(el('button', { className: 'card', onclick: () => openProject(p.id) },
      el('span', { className: 'emoji', textContent: p.emoji || '📱' }),
      el('span', { className: 'body' },
        el('div', { className: 'name', textContent: p.name }),
        el('div', { className: 'desc', textContent: p.busy ? 'Claude está trabajando…' : (p.description || p.idea || '') })),
      p.running ? el('span', { className: 'dot', title: 'En marcha' }) : null));
  }
  if (!projects.length) list.append(el('div', { className: 'empty', textContent: 'Aún no tienes apps. Elige una base abajo 👇' }));

  const tpl = $('templates');
  tpl.replaceChildren();
  for (const t of templates) {
    tpl.append(el('button', { className: 'card' + (t.id === 'web-basica' ? ' new' : ''), onclick: () => newProject(t) },
      el('span', { className: 'emoji', textContent: t.emoji || '📦' }),
      el('span', { className: 'body' },
        el('div', { className: 'name', textContent: t.name }),
        el('div', { className: 'desc', textContent: t.description || '' }))));
  }
}

function newProject(template) {
  const form = $('newForm');
  form.reset();
  form.template.value = template.id;
  $('newTitle').textContent = template.id === 'web-basica' ? 'Nueva app' : `Remezclar: ${template.name}`;
  form.idea.placeholder = template.id === 'web-basica'
    ? 'Una lista de la compra compartida con mi pareja, con fotos de los productos'
    : 'Igual que esta, pero que… ';
  const dialog = $('newDialog');
  dialog.onclose = async () => {
    if (dialog.returnValue !== 'ok') return;
    try {
      const p = await api('/projects', { method: 'POST', body: { name: form.name.value, template: form.template.value, idea: form.idea.value } });
      await openProject(p.id);
      if (form.idea.value.trim()) send(form.idea.value.trim());
    } catch (err) { toast(err.message); }
  };
  dialog.showModal();
}

// ---------------- Project ----------------
async function openProject(id) {
  const p = await api(`/projects/${id}`);
  state.project = p;
  $('home').hidden = true;
  $('project').hidden = false;
  history.replaceState(null, '', `#${id}`);
  $('pEmoji').textContent = p.emoji || '📱';
  $('pName').textContent = p.name;
  renderChat(p.chat);
  renderRun(p);
  renderLog(p);
  setTab('chat');
  if (p.busy) pollWhileBusy();
}

async function refresh() {
  if (!state.project) return;
  const p = await api(`/projects/${state.project.id}`);
  state.project = p;
  $('pEmoji').textContent = p.emoji || '📱';
  $('pName').textContent = p.name;
  renderRun(p);
  renderLog(p);
  return p;
}

function renderChat(chat) {
  const box = $('messages');
  box.replaceChildren();
  if (!chat.length) {
    box.append(el('div', { className: 'msg system', textContent: 'Cuéntale a Claude qué quieres. Por ejemplo:' }));
    const ideas = state.project.template === 'audiolibros'
      ? ['Cambia los colores a tonos del espacio y pon cohetes', 'Añade un cuento sobre un perro que se llama Toby', 'Que al terminar un cuento suene una melodía suave']
      : ['Hazme una lista de tareas con fotos', 'Un temporizador de cocina con voz', 'Un álbum para guardar los dibujos de mi hija'];
    box.append(el('div', { className: 'suggest' }, ...ideas.map((t) => el('button', { textContent: t, onclick: () => send(t) }))));
  }
  for (const m of chat) addMessage(m);
  box.scrollTop = box.scrollHeight;
}

function addMessage(m) {
  const node = el('div', { className: `msg ${m.role}${m.ok === false ? ' error' : ''}` });
  if (m.role === 'assistant') node.innerHTML = md(m.text || ''); else node.textContent = m.text;
  if (m.steps?.length) {
    node.append(el('details', { className: 'steps' },
      el('summary', { textContent: `${m.steps.length} paso${m.steps.length > 1 ? 's' : ''}` }),
      el('ul', {}, ...m.steps.map((s) => el('li', { textContent: s })))));
  }
  $('messages').querySelector('.suggest')?.remove();
  $('messages').append(node);
  $('messages').scrollTop = $('messages').scrollHeight;
  return node;
}

// Sends a message and streams Claude's progress (Server-Sent Events over fetch).
async function send(text) {
  if (state.busy || !text) return;
  const id = state.project.id;
  setBusy(true);
  addMessage({ role: 'user', text });
  const working = el('div', { className: 'msg assistant' }, el('div', { className: 'working' }, el('span', { className: 'spinner' }), el('span', { textContent: 'Pensando…' })));
  $('messages').append(working);
  const status = working.querySelector('.working span:last-child');
  const steps = [];
  let reply = '';

  try {
    const res = await fetch(`/api/projects/${id}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: text }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, cut).replace(/^data: /, '');
        buf = buf.slice(cut + 2);
        const ev = JSON.parse(line);
        if (ev.type === 'tool') { steps.push(ev.label); status.textContent = ev.label; }
        if (ev.type === 'text') { reply += (reply ? '\n\n' : '') + ev.text; status.textContent = 'Escribiendo…'; }
        if (ev.type === 'done') {
          working.remove();
          addMessage({ role: 'assistant', text: reply || ev.error || 'Hecho.', steps, ok: ev.ok });
          const p = await refresh();
          if (ev.changed && p?.running) reloadPreview();
        }
      }
    }
  } catch (err) {
    working.remove();
    addMessage({ role: 'assistant', text: err.message, ok: false });
  } finally {
    setBusy(false);
  }
}

// If we reopen a project while Claude is still working (e.g. after the screen locked), poll until done.
async function pollWhileBusy() {
  setBusy(true);
  const note = addMessage({ role: 'system', text: 'Claude sigue trabajando en segundo plano…' });
  while (state.project) {
    await new Promise((r) => setTimeout(r, 3000));
    const p = await api(`/projects/${state.project.id}`).catch(() => null);
    if (p && !p.busy) { note.remove(); state.project = p; renderChat(p.chat); renderRun(p); renderLog(p); break; }
  }
  setBusy(false);
}

function setBusy(busy) {
  state.busy = busy;
  $('send').disabled = busy;
  $('undo').disabled = busy;
}

function appUrl(p) { return `${location.protocol}//${location.hostname}:${p.port}/`; }

function renderRun(p) {
  const btn = $('run');
  btn.textContent = p.running ? '■ Parar' : '▶ Ejecutar';
  btn.classList.toggle('stop', !!p.running);
  $('notRunning').hidden = !!p.running;
  $('frame').hidden = !p.running;
  $('pUrl').textContent = p.running ? appUrl(p) : '';
  $('openApp').hidden = !p.running;
  if (p.running) {
    $('openApp').href = appUrl(p);
    if (!$('frame').src.startsWith(appUrl(p))) $('frame').src = appUrl(p);
  } else {
    $('frame').removeAttribute('src');
  }
}

function reloadPreview() {
  if (state.project?.running) $('frame').src = appUrl(state.project) + '?t=' + Date.now();
}

function renderLog(p) {
  $('history').replaceChildren(...(p.history || []).map((h) =>
    el('li', {}, el('span', { textContent: h.message }), el('time', { textContent: new Date(h.at).toLocaleString() }))));
  $('logs').textContent = (p.logs || []).join('\n') || '—';
}

function setTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const t of ['chat', 'preview', 'log']) $(`tab-${t}`).hidden = t !== name;
  if (name === 'log') refresh();
}

// ---------------- wiring ----------------
document.querySelector('.tabs').onclick = (e) => { if (e.target.dataset.tab) setTab(e.target.dataset.tab); };
$('back').onclick = showHome;
$('reload').onclick = reloadPreview;

$('run').onclick = async () => {
  const p = state.project;
  try {
    await api(`/projects/${p.id}/${p.running ? 'stop' : 'run'}`, { method: 'POST' });
    const fresh = await refresh();
    if (fresh.running) setTab('preview');
  } catch (err) { toast(err.message); }
};

$('undo').onclick = async () => {
  if (!confirm('¿Deshacer el último cambio que hizo Claude?')) return;
  try {
    await api(`/projects/${state.project.id}/undo`, { method: 'POST' });
    const p = await api(`/projects/${state.project.id}`);
    state.project = p;
    renderChat(p.chat);
    renderLog(p);
    reloadPreview();
  } catch (err) { toast(err.message); }
};

$('delete').onclick = async () => {
  if (!confirm(`¿Borrar "${state.project.name}" para siempre?`)) return;
  await api(`/projects/${state.project.id}`, { method: 'DELETE' });
  showHome();
};

$('composer').onsubmit = (e) => {
  e.preventDefault();
  const text = $('input').value.trim();
  $('input').value = '';
  $('input').style.height = '';
  send(text);
};
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); $('composer').requestSubmit(); }
});
$('input').addEventListener('input', (e) => { e.target.style.height = ''; e.target.style.height = `${e.target.scrollHeight}px`; });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

const initial = location.hash.slice(1);
if (initial) openProject(initial).catch(showHome); else showHome();
