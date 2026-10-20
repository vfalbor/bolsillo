// What the system is doing, for the health monitor and the debug view: memory as Linux sees it,
// the processes using the most memory and CPU, and the tail of the logs worth watching.
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';

const TICK = 100; // USER_HZ on Linux
let prevCpu = null; // { at, pid -> cpu ticks } from the previous call, to turn ticks into %

// MemAvailable counts reclaimable cache, unlike os.freemem().
export function memInfo() {
  let text = '';
  try { text = fs.readFileSync('/proc/meminfo', 'utf8'); } catch { /* not Linux */ }
  if (!text) return { totalMB: Math.round(os.totalmem() / 1048576), availMB: Math.round(os.freemem() / 1048576), swapMB: 0, swapFreeMB: 0 };
  const mb = (k) => Math.round(Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(text)?.[1] || 0) / 1024);
  return { totalMB: mb('MemTotal'), availMB: mb('MemAvailable'), swapMB: mb('SwapTotal'), swapFreeMB: mb('SwapFree') };
}

// Top processes by memory, with CPU % since the previous call.
export function topProcesses(n = 5) {
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return []; }
  const now = Date.now(), cpu = new Map(), list = [];
  for (const pid of pids) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const name = stat.slice(stat.indexOf('(') + 1, close);
      const f = stat.slice(close + 2).split(' ');
      const ticks = Number(f[11]) + Number(f[12]); // utime + stime
      const rssMB = Math.round(Number(f[21]) * 4096 / 1048576);
      cpu.set(pid, ticks);
      const before = prevCpu?.ticks.get(pid);
      const pct = before == null ? null : Math.round(((ticks - before) / TICK) / ((now - prevCpu.at) / 1000) * 100);
      let cmd = name;
      try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 80) || name; } catch { /* gone */ }
      list.push({ pid: Number(pid), name, cmd, rssMB, cpu: pct });
    } catch { /* process ended meanwhile */ }
  }
  prevCpu = { at: now, ticks: cpu };
  return list.sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0) || b.rssMB - a.rssMB).slice(0, n);
}

export function tail(file, lines = 40) {
  try {
    const fd = fs.openSync(file, 'r'), size = fs.fstatSync(fd).size, len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n').slice(-lines).join('\n');
  } catch (err) { return `(${err.code || err.message})`; }
}

// Self-test command (BOLSILLO_DIAG_CMD), run on demand; one at a time.
let diag = null;
export function runDiag(cmd) {
  if (!cmd) return { state: 'unavailable' };
  if (diag?.state === 'running') return { state: 'running', since: diag.since };
  diag = { state: 'running', since: Date.now() };
  const child = spawn('/bin/sh', ['-c', cmd], { stdio: 'ignore', detached: true });
  child.on('exit', (code) => { diag = { ...diag, state: 'done', code, ms: Date.now() - diag.since }; });
  child.unref();
  return { state: 'started', since: diag.since };
}
export const diagState = () => diag || { state: 'idle' };
