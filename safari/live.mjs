// Follows test sessions live from results/reports.jsonl: the latest state of each session (page, disk,
// Linux, network, background), the monitor's warnings, the self-check and the end of the terminal without
// color codes.
//
//   node safari/live.mjs [--last 1] [--tail 1500] [--mon 8] [--who iPhone]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i === -1 ? d : Number(process.argv[i + 1]); };
const file = process.env.REPORTS || path.join(here, 'results/reports.jsonl');
const ANSI = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[=>()][0-9A-B]?|\r/g;

// A session starts at every "start" milestone from an IP.
const sessions = [];
const open = new Map();
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line) continue;
  let r; try { r = JSON.parse(line); } catch { continue; }
  const who = `${r.ip} ${/iPhone|iPad/.test(r.ua) ? 'iPhone' : /Chrome/.test(r.ua) ? 'Chrome' : 'other'}`;
  if (r.name === 'start' || !open.has(who)) { const s = { who, start: r.at, events: [], last: null }; sessions.push(s); open.set(who, s); }
  const s = open.get(who);
  if (r.name !== 'tick') s.events.push(`${r.at.slice(11, 19)} +${r.t}s ${r.name}`);
  s.last = r;
}

const whoArg = process.argv.includes('--who') ? process.argv[process.argv.indexOf('--who') + 1] : '';
for (const s of sessions.filter((x) => x.who.includes(whoArg)).slice(-arg('last', 1))) {
  const r = s.last, d = r.disk || {}, h = r.health || {}, g = h.guest;
  console.log(`\n=== ${s.who} · started ${s.start} · last report ${r.at} (+${r.t}s, ${r.name})${r.hidden ? ' · PAGE HIDDEN' : ''}`);
  console.log('milestones:', s.events.slice(-12).join(' | '));
  console.log(`disk: ${d.fetchedMB} MB in ${d.requests} requests, waited ${Math.round((d.waitMs || 0) / 1000)} s, corrupted ${d.badChunks ?? '?'} · RAM ${d.memMB} MB ${d.useSnapshot ? 'snapshot' : 'cold'}`);
  if (g) console.log(`linux: free ${g.availMB}/${g.totalMB} MB, load ${g.load}, apps ${g.running}${g.top ? ' · ' + g.top.map((p) => `${p.name} ${p.cpu ?? '?'}% ${p.rssMB}MB`).join(', ') : ''}`);
  console.log(`monitor: ${h.level || '?'}${h.tips?.length ? ' · ' + h.tips.join(' / ') : ''}`);
  if (r.net) console.log(`network: ${r.net.downSince ? 'DOWN' : 'fine'}, ${r.net.reconnects} reconnections`);
  if (r.bg) console.log(`background: audio ${r.bg.audio}, away ${Math.round(r.bg.lastHiddenMs / 1000)} s, frozen ${Math.round(r.bg.frozenMs / 1000)} s, alive ${r.bg.aliveWhileHidden}`);
  if (r.debug?.diag) console.log(`self-check: ${JSON.stringify(r.debug.diag)}`);
  if (r.debug?.monitor) console.log(`--- internal monitor (read ${r.debug.vmDebugAt || '?'})\n` + r.debug.monitor.trim().split('\n').slice(-arg('mon', 8)).join('\n'));
  if (r.debug?.diagLog) console.log('--- self-check\n' + r.debug.diagLog.trim());
  if (r.tail) console.log('--- terminal\n' + r.tail.replace(ANSI, '').split('\n').map((l) => l.slice(0, 160)).join('\n').slice(-arg('tail', 1500)));
}
