// Sigue en directo las sesiones de prueba a partir de results/reports.jsonl: el último estado de cada
// sesión (página, disco, Linux, red, segundo plano), los avisos del monitor, el autodiagnóstico y el
// final de la terminal sin códigos de color.
//
//   node safari/live.mjs [--last 1] [--tail 1500] [--mon 8] [--who iPhone]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i === -1 ? d : Number(process.argv[i + 1]); };
const file = process.env.REPORTS || path.join(here, 'results/reports.jsonl');
const ANSI = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[=>()][0-9A-B]?|\r/g;

// Una sesión empieza en cada hito «start» de una IP.
const sessions = [];
const open = new Map();
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line) continue;
  let r; try { r = JSON.parse(line); } catch { continue; }
  const who = `${r.ip} ${/iPhone|iPad/.test(r.ua) ? 'iPhone' : /Chrome/.test(r.ua) ? 'Chrome' : 'otro'}`;
  if (r.name === 'start' || !open.has(who)) { const s = { who, start: r.at, events: [], last: null }; sessions.push(s); open.set(who, s); }
  const s = open.get(who);
  if (r.name !== 'tick') s.events.push(`${r.at.slice(11, 19)} +${r.t}s ${r.name}`);
  s.last = r;
}

const whoArg = process.argv.includes('--who') ? process.argv[process.argv.indexOf('--who') + 1] : '';
for (const s of sessions.filter((x) => x.who.includes(whoArg)).slice(-arg('last', 1))) {
  const r = s.last, d = r.disk || {}, h = r.health || {}, g = h.guest;
  console.log(`\n=== ${s.who} · empezó ${s.start} · último informe ${r.at} (+${r.t}s, ${r.name})${r.hidden ? ' · PÁGINA OCULTA' : ''}`);
  console.log('hitos:', s.events.slice(-12).join(' | '));
  console.log(`disco: ${d.fetchedMB} MB en ${d.requests} peticiones, espera ${Math.round((d.waitMs || 0) / 1000)} s, corruptos ${d.badChunks ?? '?'} · RAM ${d.memMB} MB ${d.useSnapshot ? 'instantánea' : 'en frío'}`);
  if (g) console.log(`linux: libres ${g.availMB}/${g.totalMB} MB, carga ${g.load}, apps ${g.running}${g.top ? ' · ' + g.top.map((p) => `${p.name} ${p.cpu ?? '?'}% ${p.rssMB}MB`).join(', ') : ''}`);
  console.log(`monitor: ${h.level || '?'}${h.tips?.length ? ' · ' + h.tips.join(' / ') : ''}`);
  if (r.net) console.log(`red: ${r.net.downSince ? 'CAÍDA' : 'bien'}, ${r.net.reconnects} reconexiones`);
  if (r.bg) console.log(`segundo plano: audio ${r.bg.audio}, fuera ${Math.round(r.bg.lastHiddenMs / 1000)} s, congelado ${Math.round(r.bg.frozenMs / 1000)} s, vivo ${r.bg.aliveWhileHidden}`);
  if (r.debug?.diag) console.log(`autodiagnóstico: ${JSON.stringify(r.debug.diag)}`);
  if (r.debug?.monitor) console.log(`--- monitor interno (leído ${r.debug.vmDebugAt || '?'})\n` + r.debug.monitor.trim().split('\n').slice(-arg('mon', 8)).join('\n'));
  if (r.debug?.diagLog) console.log('--- autodiagnóstico\n' + r.debug.diagLog.trim());
  if (r.tail) console.log('--- terminal\n' + r.tail.replace(ANSI, '').split('\n').map((l) => l.slice(0, 160)).join('\n').slice(-arg('tail', 1500)));
}
