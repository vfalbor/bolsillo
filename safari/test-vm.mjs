// Prueba de extremo a extremo de Bolsillo en Safari, con WebKit (el motor de Safari) en un PC Linux.
// Simula el límite de memoria de un iPhone metiendo el navegador en un cgroup (MemoryMax): si se
// pasa, el sistema lo mata, como hace iOS con Safari.
//
//   node safari/test-vm.mjs [--htdocs build/base/htdocs] [--mem 1200M] [--browser webkit|chromium] [--query mem=768] [--jsc JSC_useOMGJIT=0 …] (solo diagnóstico)
//
// Este PC también sirve otras cosas: el navegador nunca puede llevarse toda la máquina. Corre en
// bolsillotest.slice, FUERA del slice del usuario (sudo bolsillo-sandbox, ver /usr/local/sbin): el
// 18/10/2026 dentro del slice llevó el MemoryHigh=2G del usuario al límite y congeló todas las
// sesiones, SSH incluido. Allí tiene memoria limitada (por defecto 1200M, lo que da Safari en un iPhone;
// el sandbox no admite más de 1500M; nunca más de lo libre menos
// una reserva) y sin swap, CPU al 150%, prioridad baja, y se aborta si el sistema o las sesiones del
// usuario empiezan a sufrir presión de memoria. Al salir (o con Ctrl+C) se mata el cgroup entero.
//
// Deja el informe en safari/results/<fecha>/report.json y capturas.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(process.env.HOME, 'tools/pw/package.json'));
const { webkit, chromium } = require('playwright');

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((a) => { const [k, ...v] = a.trim().split(/\s+/); return [k, v]; }));
const htdocs = path.resolve(here, args.htdocs?.[0] || 'build/base/htdocs');
// Reserva para el resto de la máquina: nunca se le da al navegador más que lo disponible menos esto.
const RESERVE_MB = 1536;
const memAvailableMB = () => Math.round(Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]) / 1024);
const toMB = (v) => { const m = /^(\d+)([KMG]?)$/i.exec(v || ''); return m ? Number(m[1]) * { K: 1 / 1024, M: 1, G: 1024, '': 1 / 1048576 }[m[2].toUpperCase()] : Infinity; };
const ceilingMB = memAvailableMB() - RESERVE_MB;
if (ceilingMB < 800) { console.error(`No hay memoria libre suficiente (${memAvailableMB()} MB disponibles); no arranco el navegador.`); process.exit(1); }
const wantedMB = toMB(args.mem?.[0] || '1200M');
const memLimit = `${Math.round(Math.min(wantedMB, ceilingMB))}M`;
if (wantedMB > ceilingMB) console.warn(`Límite de memoria recortado a ${memLimit} (disponibles ${memAvailableMB()} MB, reserva ${RESERVE_MB} MB).`);
const cpuQuota = '150%'; // lo fija bolsillo-sandbox
const browserName = args.browser?.[0] || 'webkit';
const commands = (args.cmds?.join(' ') || 'free -m;node -v;time claude --version').split(';');
const out = path.join(here, 'results', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(out, { recursive: true });
const report = { htdocs, query: args.query?.[0] || '', memLimit, cpuQuota, browser: browserName, steps: [], peakMB: 0, samples: [] };
const t0 = Date.now();
const secs = () => Math.round((Date.now() - t0) / 1000);
const log = (msg) => { const line = `[+${secs()}s] ${msg}`; console.log(line); fs.appendFileSync(path.join(out, 'log.txt'), line + '\n'); };
const step = (name, extra = {}) => { report.steps.push({ name, t: secs(), ...extra }); log(`✓ ${name} ${Object.keys(extra).length ? JSON.stringify(extra) : ''}`); };
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));

let closed = false, closing = false;
const children = [];
const run = (cmd, argv, env = {}) => {
  const p = spawn(cmd, argv, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => fs.appendFileSync(path.join(out, `${path.basename(cmd)}.log`), d));
  p.stderr.on('data', (d) => fs.appendFileSync(path.join(out, `${path.basename(cmd)}.log`), d));
  children.push(p);
  return p;
};
let scopeUnit = null;
const SANDBOX = '/usr/local/sbin/bolsillo-sandbox';
const cleanup = () => {
  // Matar systemd-run no basta: los procesos de WebKit siguen vivos dentro del scope. Se para el scope entero.
  if (scopeUnit) try { execFileSync('sudo', ['-n', SANDBOX, 'kill', scopeUnit], { stdio: 'ignore', timeout: 15000 }); } catch {}
  for (const c of children) try { c.kill('SIGKILL'); } catch {}
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { log(`✗ interrumpido (${sig})`); process.exit(130); });
process.on('uncaughtException', (e) => { log(`✗ ${e.message}`); process.exit(1); });
// Tope absoluto de duración de toda la prueba (minutos), pase lo que pase.
const hardStop = setTimeout(() => { log('✗ tope de tiempo total alcanzado'); process.exit(2); }, (Number(args.timeout?.[0] || 45) + 25) * 60000);
hardStop.unref();

// 1. Red (c2w-net) publicando los puertos del Linux: 7700 (panel) y 7701-7705 (apps) como 1xxxx.
const ports = [7700, 7701, 7702, 7703, 7704, 7705].flatMap((p) => ['-p', `127.0.0.1:${10000 + p}:${p}`]);
run(path.join(process.env.HOME, 'tools/c2w/c2w-net'), ['-mac', '02:00:00:00:00:01', ...ports, '--listen-ws', '127.0.0.1:8888']);
// 2. Puerta.
const TOKEN = 'prueba';
run(process.execPath, [path.join(here, 'gateway.js')], { PORT: '8080', GATEWAY_TOKEN: TOKEN, HTDOCS: `${here}/web:${htdocs}` });
await new Promise((r) => setTimeout(r, 1500));

// 3. Navegador, opcionalmente dentro de un cgroup con memoria limitada.
const bt = browserName === 'chromium' ? chromium : webkit;
let browser;
if (true) {
  // Lanzamos el servidor de Playwright dentro de un scope de systemd con MemoryMax (incluye todos sus hijos),
  // en bolsillotest.slice. sudo limpia el entorno: se le pasa lo necesario con env.
  const unit = scopeUnit = `bolsillo-vm-${Date.now()}`;
  const wsFile = path.join(out, 'ws-endpoint');
  const launcher = `const { ${browserName} } = require('playwright'); ${browserName}.launchServer({ headless: true, env: { ...process.env, ...${JSON.stringify(Object.fromEntries((args.jsc || []).map((kv) => kv.split('='))))} } }).then(s => { require('fs').writeFileSync(${JSON.stringify(wsFile)}, s.wsEndpoint()); });`;
  run('sudo', ['-n', SANDBOX, 'run', unit, memLimit, 'env', `HOME=${process.env.HOME}`, `PATH=${process.env.PATH}`,
    `NODE_PATH=${path.join(process.env.HOME, 'tools/pw/node_modules')}`, 'nice', '-n', '15', process.execPath, '-e', launcher]);
  for (let i = 0; i < 60 && !fs.existsSync(wsFile); i++) await new Promise((r) => setTimeout(r, 500));
  browser = await bt.connect(fs.readFileSync(wsFile, 'utf8'));
  report.cgroup = unit;
} else {
  browser = await bt.launch({ headless: true });
}
report.browserVersion = browser.version();

// Medir la memoria de todo el navegador (RSS de sus procesos) cada 0,5 s: el arranque de QEMU sube cientos de MB en un segundo.
const browserPids = () => {
  try {
    if (report.cgroup) {
      return fs.readFileSync(`${cgDir()}/cgroup.procs`, 'utf8').split('\n').filter(Boolean);
    }
    return execFileSync('pgrep', ['-f', browserName === 'webkit' ? 'pw_run|WebKit' : 'chrom']).toString().split('\n').filter(Boolean);
  } catch { return []; }
};
const cgDir = () => `/sys/fs/cgroup/bolsillotest.slice/${report.cgroup}.scope`;
// Presión de memoria (PSI, "some avg10", en %) de un cgroup: el aviso temprano de que algo se va a congelar.
const pressure = (dir) => { try { return Number(/some avg10=([\d.]+)/.exec(fs.readFileSync(`${dir}/memory.pressure`, 'utf8'))[1]); } catch { return 0; } };
const USER_SLICE = `/sys/fs/cgroup/user.slice/user-${process.getuid()}.slice`;
// Memoria real del navegador entero (todos sus procesos), como la cuenta el kernel: lo más parecido a lo que vigila iOS.
const rssMB = () => {
  try { return Math.round(Number(fs.readFileSync(`${cgDir()}/memory.current`, 'utf8')) / 1048576); } catch { return 0; }
};
const peakMB = () => {
  try { return Math.round(Number(fs.readFileSync(`${cgDir()}/memory.peak`, 'utf8')) / 1048576); } catch { return report.peakMB; }
};
let thrash = 0;
const sampler = setInterval(() => {
  const mb = rssMB();
  report.samples.push([secs(), mb]);
  // memory.peak del kernel: el pico entre muestras, que se pierde cuando el OOM mata el cgroup.
  report.peakMB = Math.max(report.peakMB, mb, peakMB());
  // Freno de emergencia: si al resto de la máquina le queda poca memoria, se para todo.
  const avail = memAvailableMB();
  if (avail < 700 && !closing) { log(`✗ freno de emergencia: solo ${avail} MB libres en el sistema`); finish(false, 'freno de emergencia por memoria del sistema'); }
  // Las sesiones del usuario (SSH, Claude Code) no pueden sufrir por la prueba.
  // El informe guarda una muestra por segundo; el freno mira todas.
  if (report.samples.length > 1 && report.samples.at(-2)[0] === secs()) report.samples.pop();
  const userPsi = pressure(USER_SLICE);
  if (userPsi > 10 && !closing) { log(`✗ freno de emergencia: presión de memoria en las sesiones del usuario ${userPsi}%`); finish(false, 'freno de emergencia por presión en el slice del usuario'); }
  // El propio navegador rascando su caché al borde del techo (thrashing): en un iPhone ya estaría muerto,
  // y aquí ese rascado de disco atasca a toda la máquina (el 18/10 tiró el SSH). Se corta a la segunda muestra.
  const psi = pressure(cgDir());
  report.psi = Math.max(report.psi || 0, psi);
  thrash = psi > 15 ? thrash + 1 : 0;
  if (thrash >= 8 && !closing) { log(`✗ freno: el navegador está en thrashing (presión ${psi}%) cerca de su techo de ${memLimit}`); finish(false, 'thrashing de memoria del navegador (equivale a que iOS mate la pestaña)'); }
}, 500);

const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // tamaño iPhone 14/15
page.on('console', (m) => { if (/\[bolsillo\]|rror/.test(m.text())) log(`consola: ${m.text().slice(0, 300)}`); });
page.on('crash', () => { log('✗ la página se cayó (crash)'); report.crashed = true; });
browser.on('disconnected', () => { closed = true; if (!closing) log('✗ el navegador se cerró (¿límite de memoria?)'); });

const finish = async (ok, why = '') => {
  if (closing) return;
  closing = true;
  clearInterval(sampler);
  report.peakMB = Math.max(report.peakMB, peakMB());
  try { report.oomKills = /oom_kill (\d+)/.exec(fs.readFileSync(`${cgDir()}/memory.events`, 'utf8'))?.[1]; } catch {}
  report.ok = ok;
  report.why = why;
  report.totalSeconds = secs();
  try { await page.screenshot({ path: path.join(out, 'screen.png') }); } catch {}
  // Lo que se ve en la terminal del Linux: dice por dónde se quedó el arranque.
  try {
    report.terminal = await page.evaluate(() => {
      const b = window.bolsillo.xterm.buffer.active; const lines = [];
      for (let i = 0; i < b.length; i++) lines.push(b.getLine(i).translateToString(true));
      return lines.join('\n').trim().split('\n').slice(-25).join('\n');
    });
    report.disk = await page.evaluate(() => window.bolsilloDisk);
  } catch {}
  save();
  log(`${ok ? 'OK' : 'FALLA'} ${why} · pico de memoria del navegador: ${report.peakMB} MB`);
  try { await browser.close(); } catch {}
  cleanup();
  process.exit(0);
};

try {
  // --query mem=768&cache=32 → opciones de web/lazy-load.js
  await page.goto(`http://localhost:8080/vm/?t=${TOKEN}${args.query ? '&' + args.query[0] : ''}`, { timeout: 60000 });
  step('página abierta', { crossOriginIsolated: await page.evaluate(() => crossOriginIsolated) });
  // Esperar al panel de Bolsillo dentro del Linux.
  const deadline = Date.now() + Number(args.timeout?.[0] || 45) * 60000;
  let seen = 0;
  while (!closed && Date.now() < deadline) {
    const ev = await page.evaluate(() => window.bolsillo?.events || []).catch(() => null);
    if (ev === null) break;
    for (const e of ev.slice(seen)) step(`evento: ${e.name}`, { pageSeconds: e.t, rssMB: rssMB() });
    seen = ev.length;
    if (ev.some((e) => e.name === 'panel' || e.name === 'error')) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (closed || report.crashed) await finish(false, 'el navegador murió antes de arrancar el Linux');
  const info = await page.evaluate(() => window.bolsillo.info).catch(() => null);
  if (!info) await finish(false, 'el panel de Bolsillo no respondió a tiempo');
  step('panel de Bolsillo dentro del Linux', { claude: info.claude, rssMB: rssMB() });

  // Comandos en la terminal.
  await page.click('#tTerm');
  const screenText = () => page.evaluate(() => {
    const b = window.bolsillo.xterm.buffer.active; const lines = [];
    for (let i = 0; i < b.length; i++) lines.push(b.getLine(i).translateToString(true));
    return lines.join('\n');
  });
  for (const cmd of commands) {
    const marker = `__fin_${Math.random().toString(36).slice(2, 8)}__`;
    const start = secs();
    await page.keyboard.type(`${cmd}; echo ${marker}\n`, { delay: 5 });
    let text = '';
    const until = Date.now() + 20 * 60000;
    while (!closed && Date.now() < until) {
      text = await screenText().catch(() => '');
      if (text.split(marker).length > 2) break; // la orden escrita + la salida
      await new Promise((r) => setTimeout(r, 3000));
    }
    const outText = text.split(marker).slice(-2, -1)[0] || text.slice(-1500);
    step(`$ ${cmd}`, { seconds: secs() - start, rssMB: rssMB(), salida: outText.trim().split('\n').slice(-12).join(' | ').slice(0, 900) });
    if (closed) await finish(false, `el navegador murió durante «${cmd}»`);
  }
  await finish(true);
} catch (e) {
  await finish(false, e.message.split('\n')[0]);
}
