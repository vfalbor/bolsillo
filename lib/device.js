// Bridge to the phone's hardware. Two backends:
//  - Bolsillo's own Android app: a tiny HTTP server on 127.0.0.1 inside the APK
//    (BOLSILLO_BRIDGE=http://127.0.0.1:7699, BOLSILLO_BRIDGE_TOKEN=...).
//  - Termux:API (https://wiki.termux.com/wiki/Termux:API) when running inside Termux.
// On a normal Linux box neither exists and every capability reports unavailable.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// name -> how to call it through Termux. args(body) builds the CLI arguments from the request body.
export const CAPABILITIES = {
  battery: { cmd: 'termux-battery-status', args: () => [], json: true, desc: 'Battery status' },
  location: { cmd: 'termux-location', args: () => ['-p', 'network'], json: true, desc: 'Approximate location' },
  notify: { cmd: 'termux-notification', args: (b) => ['--title', String(b.title || 'Bolsillo'), '--content', String(b.text || '')], desc: 'Show a notification' },
  speak: { cmd: 'termux-tts-speak', args: (b) => [String(b.text || '')], desc: 'Read text aloud' },
  vibrate: { cmd: 'termux-vibrate', args: (b) => ['-d', String(Number(b.ms) || 300)], desc: 'Vibrate' },
  torch: { cmd: 'termux-torch', args: (b) => [b.on ? 'on' : 'off'], desc: 'Flashlight' },
  clipboard: { cmd: 'termux-clipboard-get', args: () => [], desc: 'Read the clipboard' },
  photo: { cmd: 'termux-camera-photo', args: (b) => ['-c', String(Number(b.camera) || 0), String(b.path || 'photo.jpg')], desc: 'Take a photo' },
  sensors: { cmd: 'termux-sensor', args: () => ['-a', '-n', '1'], json: true, desc: 'Read the sensors' },
  // Only the Android app can do these.
  shortcut: { desc: 'Add an app to the home screen' },
  open: { desc: 'Open a link in the browser' },
};

function bridge() {
  const url = process.env.BOLSILLO_BRIDGE;
  return url ? { url: url.replace(/\/$/, ''), token: process.env.BOLSILLO_BRIDGE_TOKEN || '' } : null;
}

async function callBridge(b, name, body = {}) {
  const res = await fetch(`${b.url}/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${b.token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `The phone answered ${res.status}`), { status: res.status });
  return data;
}

let termuxAvailable;
export async function listCapabilities() {
  const b = bridge();
  if (b) {
    let names = [];
    try { names = (await callBridge(b, 'caps')).caps || []; } catch { /* app not answering */ }
    return Object.entries(CAPABILITIES).map(([name, c]) => ({ name, desc: c.desc, available: names.includes(name) }));
  }
  if (termuxAvailable === undefined) {
    try { await run('sh', ['-c', 'command -v termux-battery-status']); termuxAvailable = true; } catch { termuxAvailable = false; }
  }
  return Object.entries(CAPABILITIES).map(([name, c]) => ({ name, desc: c.desc, available: termuxAvailable && !!c.cmd }));
}

export function onAndroid() {
  return !!bridge();
}

export async function callCapability(name, body = {}) {
  const cap = CAPABILITIES[name];
  if (!cap) throw Object.assign(new Error(`Capacidad desconocida: ${name}`), { status: 404 });
  const b = bridge();
  if (b) return callBridge(b, name, body);
  if (!cap.cmd) throw Object.assign(new Error('Only available in the Bolsillo Android app'), { status: 501 });
  try {
    const { stdout } = await run(cap.cmd, cap.args(body), { timeout: 20000 });
    return cap.json ? JSON.parse(stdout || 'null') : { ok: true, output: stdout.trim() };
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw Object.assign(new Error('Not available: install Termux:API on the phone (pkg install termux-api)'), { status: 501 });
    }
    throw err;
  }
}
