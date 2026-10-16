// Kids audiobook player. Books come from libros.json (text read aloud with the phone's voice
// or an "audio" file) plus audio files the parent adds, stored in IndexedDB.
const $ = (id) => document.getElementById(id);
const audio = $('audio');
const COLORS = ['#f7c59f', '#b8e0d2', '#d6c1f0', '#f5b2b2', '#bde0fe', '#ffe29a'];

let books = [];
let current = null;
let sleepTimer = null;
let sleepMinutes = 0;

// ---------- storage ----------
const progress = JSON.parse(localStorage.getItem('progreso') || '{}');
const saveProgress = () => localStorage.setItem('progreso', JSON.stringify(progress));

function db() {
  return new Promise((ok, fail) => {
    const req = indexedDB.open('audiolibros', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('audios', { keyPath: 'id' });
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
}
async function storeAll(mode, fn) {
  const tx = (await db()).transaction('audios', mode);
  const out = fn(tx.objectStore('audios'));
  return new Promise((ok) => { tx.oncomplete = () => ok(out.result); });
}

// ---------- library ----------
async function load() {
  const base = await fetch('libros.json').then((r) => r.json()).catch(() => []);
  const mine = (await storeAll('readonly', (s) => s.getAll())) || [];
  books = [...base, ...mine.map((m, i) => ({ ...m, color: COLORS[i % COLORS.length], propio: true }))];
  render();
}

function render() {
  const grid = $('grid');
  grid.innerHTML = '';
  for (const b of books) {
    const btn = document.createElement('button');
    btn.className = 'book';
    btn.style.background = b.color || COLORS[0];
    const pct = Math.round((progress[b.id]?.pct || 0) * 100);
    btn.innerHTML = `<span class="e">${b.emoji || '📖'}</span><span class="t"></span><span class="p">${pct ? `${pct}% escuchado` : 'Nuevo'}</span>`;
    btn.querySelector('.t').textContent = b.titulo;
    btn.onclick = () => open(b);
    if (b.propio) btn.oncontextmenu = (e) => { e.preventDefault(); removeBook(b); };
    grid.append(btn);
  }
  const add = document.createElement('button');
  add.className = 'book add';
  add.innerHTML = '<span class="e">➕</span><span class="t">Añadir audio</span>';
  add.onclick = () => $('file').click();
  grid.append(add);
}

$('file').onchange = async (e) => {
  for (const f of e.target.files) {
    const id = 'propio-' + Date.now() + Math.random().toString(36).slice(2, 6);
    const titulo = f.name.replace(/\.[^.]+$/, '');
    await storeAll('readwrite', (s) => s.put({ id, titulo, emoji: '🎵', blob: f }));
  }
  e.target.value = '';
  load();
};

async function removeBook(b) {
  if (!confirm(`¿Borrar "${b.titulo}"?`)) return;
  await storeAll('readwrite', (s) => s.delete(b.id));
  load();
}

// ---------- player ----------
// Text books are spoken sentence by sentence so we can pause, resume and track progress.
const speech = { sentences: [], i: 0, playing: false };

function open(b) {
  stop();
  current = b;
  $('player').classList.add('on');
  $('nowE').textContent = b.emoji || '📖';
  $('nowT').textContent = b.titulo;
  if (b.blob || b.audio) {
    audio.src = b.blob ? URL.createObjectURL(b.blob) : b.audio;
    audio.currentTime = progress[b.id]?.t || 0;
  } else {
    speech.sentences = b.texto.match(/[^.!?]+[.!?]*/g) || [b.texto];
    speech.i = progress[b.id]?.i || 0;
    if (speech.i >= speech.sentences.length) speech.i = 0;
  }
  play();
}

function play() {
  if (!current) return;
  if (current.blob || current.audio) audio.play();
  else { speech.playing = true; speakNext(); }
  $('play').textContent = '⏸';
}

function pause() {
  audio.pause();
  speech.playing = false;
  speechSynthesis.cancel();
  $('play').textContent = '▶';
}

function stop() { pause(); audio.removeAttribute('src'); }

function speakNext() {
  if (!speech.playing) return;
  if (speech.i >= speech.sentences.length) { finished(); return; }
  const u = new SpeechSynthesisUtterance(speech.sentences[speech.i]);
  u.lang = 'es-ES';
  u.rate = 0.9;
  u.pitch = 1.1;
  u.onend = () => { if (!speech.playing) return; speech.i++; track(); speakNext(); };
  speechSynthesis.speak(u);
}

function track() {
  if (!current) return;
  if (current.blob || current.audio) {
    const pct = audio.duration ? audio.currentTime / audio.duration : 0;
    progress[current.id] = { t: audio.currentTime, pct };
  } else {
    progress[current.id] = { i: speech.i, pct: speech.i / speech.sentences.length };
  }
  $('prog').style.width = `${(progress[current.id].pct * 100).toFixed(1)}%`;
  saveProgress();
}

function finished() {
  pause();
  progress[current.id] = { pct: 1 };
  saveProgress();
  render();
}

function skip(sec) {
  if (current?.blob || current?.audio) audio.currentTime = Math.max(0, audio.currentTime + sec);
  else {
    speechSynthesis.cancel();
    speech.i = Math.max(0, Math.min(speech.sentences.length - 1, speech.i + Math.sign(sec)));
    track();
    if (speech.playing) speakNext();
  }
}

audio.ontimeupdate = track;
audio.onended = finished;
$('play').onclick = () => ($('play').textContent === '▶' ? play() : pause());
$('back').onclick = () => skip(-15);
$('fwd').onclick = () => skip(15);

// Sleep timer cycles Off → 10 → 20 → 30 min.
$('sleep').onclick = () => {
  sleepMinutes = sleepMinutes >= 30 ? 0 : sleepMinutes + 10;
  clearTimeout(sleepTimer);
  $('sleep').textContent = sleepMinutes ? `🌙 ${sleepMinutes}'` : '🌙 Off';
  if (sleepMinutes) sleepTimer = setTimeout(() => { pause(); sleepMinutes = 0; $('sleep').textContent = '🌙 Off'; }, sleepMinutes * 60000);
};

load();
