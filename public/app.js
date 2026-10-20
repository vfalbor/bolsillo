// Bolsillo UI: an app store for the apps you make on your phone, plus a chat that tells
// Claude Code what to build. Navigation lives in the URL hash so the phone's back button works:
//   #apps #store #create #settings   tabs
//   #app/<id>     app page        #taller/<id>   talk to Claude about it        #play/<id>   the app itself
const $ = (id) => document.getElementById(id);
const state = { info: null, templates: [], projects: [], project: null, busy: false };

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

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

// Each app gets a stable color from its id.
function tile(p, size = '') {
  let h = 0;
  for (const c of p.id || p.name || '') h = (h * 31 + c.charCodeAt(0)) % 360;
  return el('span', { className: `tile ${size}`, style: `--h:${h}`, textContent: p.emoji || '📱' });
}

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

const go = (hash) => { if (location.hash !== hash) location.hash = hash; else route(); };
const back = () => (history.length > 1 ? history.back() : go('#apps'));

// ---------------- Router ----------------
async function route() {
  const [name, id] = location.hash.slice(1).split('/');
  const pages = { app: 'detail', taller: 'workshop', play: 'player' };
  for (const p of ['detail', 'workshop', 'player']) $(p).hidden = pages[name] !== p;
  if (name !== 'play') $('frame').removeAttribute('src');
  const tab = pages[name] ? null : (['apps', 'store', 'create', 'settings'].includes(name) ? name : 'apps');
  $('tabs').hidden = !tab;
  $('tabbar').hidden = !tab;
  try {
    if (tab) return await showTab(tab);
    if (name === 'app') return await showDetail(id);
    if (name === 'taller') return await showWorkshop(id);
    if (name === 'play') return await showPlayer(id);
  } catch (err) {
    toast(err.message);
    if (!tab) go('#apps');
  }
}

async function showTab(tab) {
  for (const t of ['apps', 'store', 'create', 'settings']) $(`v-${t}`).hidden = t !== tab;
  for (const a of $('tabbar').querySelectorAll('a')) a.classList.toggle('on', a.dataset.tab === tab);
  scrollTo(0, 0);
  if (tab === 'apps') return renderApps();
  if (tab === 'store') return renderStore();
  if (tab === 'create') return renderCreate();
  if (tab === 'settings') return renderSettings();
}

async function loadInfo() {
  state.info = await api('/info');
  return state.info;
}

// ---------------- Mis apps ----------------
async function renderApps() {
  const [projects, info] = await Promise.all([api('/projects'), loadInfo()]);
  state.projects = projects;
  const acc = info.account || {};
  $('connectBanner').hidden = !!acc.loggedIn;
  $('status').textContent = !acc.installed ? '⚠️ Claude Code no está instalado'
    : `${projects.length} app${projects.length === 1 ? '' : 's'} · ${info.android ? 'en tu móvil 📱' : 'en este equipo'}`;
  $('grid').replaceChildren(...projects.map((p) => el('a', { className: 'app', href: `#app/${p.id}` },
    tile(p), el('span', { className: 'app-name', textContent: p.name }),
    p.busy ? el('span', { className: 'badge work', title: 'Claude está trabajando' }) : p.running ? el('span', { className: 'badge', title: 'En marcha' }) : null)));
  $('noApps').hidden = projects.length > 0;
}

// ---------------- Descubrir ----------------
async function renderStore() {
  state.templates = await api('/templates');
  const items = state.templates.filter((t) => t.id !== 'web-basica');
  const featured = items.find((t) => t.id === 'audiolibros') || items[0];
  $('featured').replaceChildren(featured ? el('button', { className: 'featured', onclick: () => openTemplate(featured) },
    el('span', { className: 'f-label', textContent: 'Destacada' }),
    tile(featured, 'lg'),
    el('span', { className: 'f-name', textContent: featured.name }),
    el('span', { className: 'f-desc', textContent: featured.description || '' })) : '');
  $('catalog').replaceChildren(
    ...items.map((t) => el('div', { className: 'card' },
      tile(t),
      el('button', { className: 'body', onclick: () => openTemplate(t) },
        el('div', { className: 'name', textContent: t.name }),
        el('div', { className: 'desc', textContent: t.category ? `${t.category} · ${t.description || ''}` : t.description || '' })),
      el('button', { className: 'pill small', textContent: 'Obtener', onclick: () => openTemplate(t) }))),
    el('a', { className: 'card new', href: '#create' }, el('span', { className: 'tile', textContent: '＋' }),
      el('span', { className: 'body' }, el('div', { className: 'name', textContent: 'Empieza de cero' }),
        el('div', { className: 'desc', textContent: 'Describe tu idea y Claude la construye' }))));
}

function openTemplate(t) {
  const form = $('tplForm');
  form.reset();
  $('tIcon').replaceWith(Object.assign(tile(t, 'lg'), { id: 'tIcon' }));
  $('tName').textContent = t.name;
  $('tCat').textContent = t.category || '';
  $('tDesc').textContent = t.description || '';
  const label = () => { $('tGo').textContent = form.idea.value.trim() ? '✨ Remezclar con Claude' : 'Obtener'; };
  form.idea.oninput = label;
  label();
  const dialog = $('tplDialog');
  dialog.onclose = async () => {
    if (dialog.returnValue !== 'ok') return;
    const idea = form.idea.value.trim();
    try {
      const p = await api('/projects', { method: 'POST', body: { name: t.name, template: t.id, idea } });
      if (idea) { pendingMessage = idea; go(`#taller/${p.id}`); } else { toast(`«${p.name}» ya está en Mis apps`); go(`#app/${p.id}`); }
    } catch (err) { toast(err.message); }
  };
  dialog.showModal();
}

// ---------------- Crear ----------------
const IDEAS = ['Una lista de tareas para la familia con fotos', 'Un diario de lo que come el bebé', 'Un juego de preguntas de capitales', 'Un contador de días sin fumar'];
let pendingMessage = null;

function renderCreate() {
  const form = $('createForm');
  $('ideaChips').replaceChildren(...IDEAS.map((idea) => el('button', {
    type: 'button', className: 'chip', textContent: idea,
    onclick: () => { form.idea.value = idea; if (!form.name.value) form.name.value = idea.replace(/^(Un|Una) /, '').split(' ').slice(0, 3).join(' '); },
  })));
}

$('createForm').onsubmit = async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    const p = await api('/projects', { method: 'POST', body: { name: form.name.value.trim(), template: 'web-basica', idea: form.idea.value.trim() } });
    pendingMessage = form.idea.value.trim();
    form.reset();
    go(`#taller/${p.id}`);
  } catch (err) { toast(err.message); }
};

// ---------------- App detail ----------------
async function showDetail(id) {
  const p = await api(`/projects/${id}`);
  state.project = p;
  if (!state.info) await loadInfo();
  $('dIcon').replaceWith(Object.assign(tile(p, 'xl'), { id: 'dIcon' }));
  $('dName').textContent = p.name;
  $('dMeta').textContent = [p.busy ? 'Claude está trabajando…' : p.running ? '● En marcha' : null,
    `${p.history?.length || 0} versión${p.history?.length === 1 ? '' : 'es'}`].filter(Boolean).join(' · ');
  $('dDesc').textContent = p.description || p.idea || '';
  $('dShortcut').hidden = !state.info?.android;
  $('dHistory').replaceChildren(...(p.history || []).slice(0, 8).map((h) =>
    el('li', {}, el('span', { textContent: h.message }), el('time', { textContent: new Date(h.at).toLocaleString() }))));
  $('dUndo').disabled = (p.history?.length || 0) < 2 || p.busy;
  $('dRun').textContent = p.running ? `En marcha en el puerto ${p.port}` : 'Parada';
  $('dLogs').textContent = (p.logs || []).join('\n') || '—';
  $('dStop').hidden = !p.running;
}

$('dOpen').onclick = () => go(`#play/${state.project.id}`);
$('dChange').onclick = () => go(`#taller/${state.project.id}`);
$('dShortcut').onclick = async () => {
  const p = state.project;
  try {
    await api('/device/shortcut', { method: 'POST', body: { id: p.id, name: p.name, emoji: p.emoji || '📱' } });
    toast('Listo: búscala en la pantalla de inicio');
  } catch (err) { toast(err.message); }
};
$('dUndo').onclick = async () => {
  if (!confirm('¿Deshacer el último cambio que hizo Claude?')) return;
  try { await api(`/projects/${state.project.id}/undo`, { method: 'POST' }); toast('Cambio deshecho'); showDetail(state.project.id); } catch (err) { toast(err.message); }
};
$('dStop').onclick = async () => { await api(`/projects/${state.project.id}/stop`, { method: 'POST' }); showDetail(state.project.id); };
$('dDelete').onclick = async () => {
  if (!confirm(`¿Borrar «${state.project.name}» para siempre?`)) return;
  await api(`/projects/${state.project.id}`, { method: 'DELETE' });
  go('#apps');
};

// ---------------- Player ----------------
function appUrl(p) {
  const base = state.info?.appBase;
  return base ? new URL(base.replace('{port}', p.port), location.href).href : `${location.protocol}//${location.hostname}:${p.port}/`;
}

async function showPlayer(id) {
  const run = await api(`/projects/${id}/run`, { method: 'POST' });
  const p = state.project?.id === id ? state.project : await api(`/projects/${id}`);
  state.project = { ...p, ...run };
  $('plName').textContent = `${p.emoji || ''} ${p.name}`;
  $('frame').src = appUrl(state.project);
}
$('plReload').onclick = () => { $('frame').src = appUrl(state.project) + '?t=' + Date.now(); };
$('plChange').onclick = () => go(`#taller/${state.project.id}`);

// ---------------- Workshop (chat with Claude) ----------------
async function showWorkshop(id) {
  const p = await api(`/projects/${id}`);
  state.project = p;
  if (!state.info) await loadInfo().catch(() => {});
  $('wIcon').textContent = p.emoji || '📱';
  $('wName').textContent = p.name;
  renderChat(p.chat);
  if (p.busy) pollWhileBusy();
  else if (pendingMessage) { const m = pendingMessage; pendingMessage = null; send(m); }
}

function renderChat(chat) {
  const box = $('messages');
  box.replaceChildren();
  if (!chat.length) {
    box.append(el('div', { className: 'msg system', textContent: 'Cuéntale a Claude qué quieres cambiar. Por ejemplo:' }));
    const ideas = {
      audiolibros: ['Cambia los colores a tonos del espacio y pon cohetes', 'Añade un cuento sobre un perro que se llama Toby', 'Que al terminar un cuento suene una melodía suave'],
      'lista-compra': ['Organiza la lista por pasillos del súper', 'Que pueda compartir la lista por WhatsApp', 'Añade el precio y calcula el total'],
      temporizador: ['Añade recetas con sus tiempos', 'Que el aviso sea una canción', 'Pon modo pantalla siempre encendida'],
    }[state.project.template] || ['Hazme una lista de tareas con fotos', 'Un temporizador de cocina con voz', 'Un álbum para guardar los dibujos de mi hija'];
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
  if (state.info && !state.info.account?.loggedIn) {
    addMessage({ role: 'system', text: 'Primero conecta tu cuenta de Claude en Ajustes.' });
    return;
  }
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
          if (ev.ok) addTryButton();
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

function addTryButton() {
  const p = state.project;
  if (!p) return;
  $('messages').append(el('div', { className: 'msg system' }, el('button', { className: 'pill primary small', textContent: '▶ Probar la app', onclick: () => go(`#play/${p.id}`) })));
  $('messages').scrollTop = $('messages').scrollHeight;
  // Refresh name/emoji in case Claude changed them.
  api(`/projects/${p.id}`).then((fresh) => { $('wIcon').textContent = fresh.emoji || '📱'; $('wName').textContent = fresh.name; }).catch(() => {});
}

// If we reopen a project while Claude is still working (e.g. after the screen locked), poll until done.
async function pollWhileBusy() {
  setBusy(true);
  const id = state.project.id;
  const note = addMessage({ role: 'system', text: 'Claude sigue trabajando en segundo plano…' });
  while (location.hash === `#taller/${id}`) {
    await new Promise((r) => setTimeout(r, 3000));
    const p = await api(`/projects/${id}`).catch(() => null);
    if (p && !p.busy) { note.remove(); state.project = p; renderChat(p.chat); break; }
  }
  setBusy(false);
}

function setBusy(busy) {
  state.busy = busy;
  $('send').disabled = busy;
}

$('wTry').onclick = () => go(`#play/${state.project.id}`);
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

// ---------------- Ajustes ----------------
async function renderSettings() {
  const info = await loadInfo();
  renderAccount(info.account || {});
  const caps = info.device || [];
  const any = caps.some((c) => c.available);
  $('phoneSub').textContent = any ? 'Lo que tus apps pueden usar del teléfono:'
    : info.android ? 'No se pudo hablar con el móvil.' : 'Aquí no hay acceso al hardware (esto no es la app de Android).';
  $('caps').replaceChildren(...caps.map((c) => el('li', { className: c.available ? 'yes' : 'no' },
    el('span', { textContent: c.available ? '✓' : '—' }), el('span', { textContent: c.desc }))));
  $('testVoice').hidden = !caps.find((c) => c.name === 'speak')?.available;
  $('about').textContent = `Bolsillo · Claude Code ${info.account?.version || '—'}${info.android ? ' · Android' : ''}`;
}

function renderAccount(acc) {
  const ok = acc.loggedIn;
  const wait = acc.checking && !ok;
  $('accIco').textContent = !acc.installed ? '⚠️' : wait ? '⏳' : ok ? '✅' : '🔑';
  $('accTitle').textContent = !acc.installed ? 'Claude Code no está instalado' : wait ? 'Comprobando Claude Code…' : ok ? 'Conectado' : 'Sin conectar';
  $('accSub').textContent = !acc.installed ? 'Reinstala Bolsillo o revisa la consola.'
    : wait ? 'En un Linux emulado tarda unos minutos la primera vez.'
    : ok ? (acc.method === 'key' ? 'Usando la clave guardada' : 'Con tu cuenta de Claude') : 'Claude necesita tu cuenta para construir apps.';
  $('loginBox').hidden = ok || !acc.installed || wait;
  if (wait) setTimeout(async () => renderAccount((await loadInfo()).account || {}), 10000);
  $('forgetKey').hidden = acc.method !== 'key';
}

let loginPoll;
$('loginStart').onclick = async () => {
  $('loginMsg').textContent = 'Preparando…';
  $('loginStart').disabled = true;
  try {
    let s = await api('/claude/login', { method: 'POST' });
    clearInterval(loginPoll);
    loginPoll = setInterval(async () => {
      s = await api('/claude/login').catch(() => s);
      showLogin(s);
      if (s.state === 'done' || s.state === 'error' || s.state === 'idle') clearInterval(loginPoll);
    }, 1000);
    showLogin(s);
  } catch (err) { $('loginMsg').textContent = err.message; $('loginStart').disabled = false; }
};

function showLogin(s) {
  $('loginSteps').hidden = !s.url || s.state === 'done';
  if (s.url) $('loginLink').href = s.url;
  $('loginStart').hidden = !!s.url && s.state !== 'error';
  $('loginStart').disabled = s.state === 'waiting' && !s.url;
  $('loginMsg').textContent = {
    waiting: s.url ? '' : 'Preparando…', checking: 'Comprobando el código…',
    done: '¡Conectado! Ya puedes crear apps.', error: `No se pudo: ${s.error || 'inténtalo otra vez'}`,
  }[s.state] || '';
  if (s.state === 'done') { state.info = null; setTimeout(renderSettings, 800); }
  if (s.state === 'error') $('loginStart').textContent = 'Intentarlo otra vez';
}

$('codeForm').onsubmit = async (e) => {
  e.preventDefault();
  try { showLogin(await api('/claude/login/code', { method: 'POST', body: { code: e.target.code.value } })); e.target.reset(); } catch (err) { $('loginMsg').textContent = err.message; }
};
$('keyForm').onsubmit = async (e) => {
  e.preventDefault();
  try { renderAccount(await api('/claude/key', { method: 'POST', body: { key: e.target.key.value } })); e.target.reset(); toast('Clave guardada'); } catch (err) { toast(err.message); }
};
$('forgetKey').onclick = async () => { renderAccount(await api('/claude/key', { method: 'DELETE' })); };
$('connectBanner').onclick = () => go('#settings');
$('testVoice').onclick = () => api('/device/speak', { method: 'POST', body: { text: 'Hola, soy tu móvil. Bolsillo funciona.' } }).catch((err) => toast(err.message));

$('shellForm').onsubmit = async (e) => {
  e.preventDefault();
  const out = $('shellOut');
  out.textContent = `$ ${e.target.cmd.value}\n…`;
  try {
    const r = await api('/shell', { method: 'POST', body: { cmd: e.target.cmd.value } });
    out.textContent = `$ ${e.target.cmd.value}\n${r.output}${r.code ? `\n[código ${r.code}]` : ''}`;
  } catch (err) { out.textContent = err.message; }
};

// ---------------- wiring ----------------
for (const b of document.querySelectorAll('.back')) b.onclick = back;
window.addEventListener('hashchange', route);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
route();
