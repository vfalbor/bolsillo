// Bridge to the phone's hardware through Termux:API (https://wiki.termux.com/wiki/Termux:API).
// On a normal Linux box the commands don't exist and every capability reports unavailable.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// name -> how to call it. args(body) builds the CLI arguments from the request body.
export const CAPABILITIES = {
  battery: { cmd: 'termux-battery-status', args: () => [], json: true, desc: 'Estado de la batería' },
  location: { cmd: 'termux-location', args: () => ['-p', 'network'], json: true, desc: 'Ubicación aproximada' },
  notify: { cmd: 'termux-notification', args: (b) => ['--title', String(b.title || 'Bolsillo'), '--content', String(b.text || '')], desc: 'Mostrar notificación' },
  speak: { cmd: 'termux-tts-speak', args: (b) => [String(b.text || '')], desc: 'Leer texto en voz alta' },
  vibrate: { cmd: 'termux-vibrate', args: (b) => ['-d', String(Number(b.ms) || 300)], desc: 'Vibrar' },
  torch: { cmd: 'termux-torch', args: (b) => [b.on ? 'on' : 'off'], desc: 'Linterna' },
  clipboard: { cmd: 'termux-clipboard-get', args: () => [], desc: 'Leer portapapeles' },
  photo: { cmd: 'termux-camera-photo', args: (b) => ['-c', String(Number(b.camera) || 0), String(b.path || 'foto.jpg')], desc: 'Hacer una foto' },
  sensors: { cmd: 'termux-sensor', args: () => ['-a', '-n', '1'], json: true, desc: 'Leer sensores' },
};

let available;
export async function listCapabilities() {
  if (!available) {
    try { await run('sh', ['-c', 'command -v termux-battery-status']); available = true; } catch { available = false; }
  }
  return Object.entries(CAPABILITIES).map(([name, c]) => ({ name, desc: c.desc, available }));
}

export async function callCapability(name, body = {}) {
  const cap = CAPABILITIES[name];
  if (!cap) throw Object.assign(new Error(`Capacidad desconocida: ${name}`), { status: 404 });
  try {
    const { stdout } = await run(cap.cmd, cap.args(body), { timeout: 20000 });
    return cap.json ? JSON.parse(stdout || 'null') : { ok: true, output: stdout.trim() };
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw Object.assign(new Error('No disponible: instala Termux:API en el móvil (pkg install termux-api)'), { status: 501 });
    }
    throw err;
  }
}
