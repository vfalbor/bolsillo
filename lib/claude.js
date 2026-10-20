// The user's Claude account: is Claude Code installed, is it signed in, and a sign-in flow
// that works from a phone screen (no terminal): we run `claude auth login` inside a
// pseudo-terminal, show its link as a button and type the code the user pastes back.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { cleanEnv } from './agent.js';

const URL_RE = /https:\/\/[^\s\x07\x1b"'<>]+oauth\/authorize[^\s\x07\x1b"'<>]*/;
const ANSI_RE = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[=>]/g;

function findBin(bin) {
  const dirs = bin.includes('/') ? [''] : (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const file = path.join(dir, bin);
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch { /* next */ }
  }
  return null;
}

export class ClaudeAccount {
  constructor({ claudeBin = 'claude', dataDir }) {
    this.claudeBin = claudeBin;
    // Under emulation (Safari, old phones) the first run of the 270 MB binary can take minutes.
    this.timeout = Number(process.env.CLAUDE_TIMEOUT_MS) || 20000;
    this.keyFile = path.join(dataDir, 'claude-key.json');
    this.cache = null;
    this.login = null; // { proc, output, url, state: 'waiting'|'checking'|'done'|'error', error }
  }

  // Extra environment for every Claude Code run (a pasted API key or long-lived token).
  env() {
    let key = '';
    try { key = JSON.parse(fs.readFileSync(this.keyFile, 'utf8')).key || ''; } catch { /* none saved */ }
    if (!key) return {};
    return key.startsWith('sk-ant-oat') ? { CLAUDE_CODE_OAUTH_TOKEN: key } : { ANTHROPIC_API_KEY: key };
  }

  childEnv(extra = {}) {
    return { ...cleanEnv(process.env), ...this.env(), ...extra };
  }

  saveKey(key) {
    key = String(key || '').trim();
    if (!/^sk-ant-[\w-]{10,}$/.test(key)) throw Object.assign(new Error('Eso no parece una clave de Claude (empieza por sk-ant-)'), { status: 400 });
    fs.writeFileSync(this.keyFile, JSON.stringify({ key }), { mode: 0o600 });
    this.cache = null;
  }

  forgetKey() {
    fs.rmSync(this.keyFile, { force: true });
    this.cache = null;
  }

  // wait: false answers within a few seconds; while a slow check runs it reports what it can
  // (binary present, pasted key) with `checking: true`, so a page never hangs on it.
  status({ fresh = false, wait = true } = {}) {
    if (!fresh && this.cache && Date.now() - this.cache.at < 60000) return Promise.resolve(this.cache.value);
    // One check at a time: each one starts Claude Code, which is slow and heavy on a phone.
    this.checking ??= this.check().finally(() => { this.checking = null; });
    if (wait) return this.checking;
    const provisional = () => {
      const key = Object.keys(this.env()).length > 0;
      return { ...(this.cache?.value || { version: null, loggedIn: key, method: key ? 'key' : null }), installed: !!findBin(this.claudeBin), checking: true };
    };
    return Promise.race([this.checking, new Promise((resolve) => setTimeout(() => resolve(provisional()), 3000).unref())]);
  }

  async check() {
    // Installed means the binary is there; a slow or failing `--version` must not hide it.
    const installed = !!findBin(this.claudeBin);
    const version = installed ? await this.exec(['--version']).then((o) => o.trim().split(' ')[0]).catch(() => null) : null;
    let loggedIn = false; let method = null;
    if (version) {
      const raw = await this.exec(['auth', 'status', '--json']).catch((err) => err.stdout || '');
      try { const s = JSON.parse(raw); loggedIn = !!s.loggedIn; method = s.authMethod || null; } catch { /* old CLI */ }
    }
    if (!loggedIn && Object.keys(this.env()).length) { loggedIn = true; method = 'key'; }
    const value = { installed, version, loggedIn, method };
    this.cache = { at: Date.now(), value };
    return value;
  }

  exec(args) {
    return new Promise((resolve, reject) => {
      execFile(this.claudeBin, args, { encoding: 'utf8', timeout: this.timeout, env: this.childEnv() }, (err, stdout) => {
        if (err) reject(Object.assign(err, { stdout })); else resolve(stdout);
      });
    });
  }

  // ---- sign-in flow ----
  startLogin() {
    if (this.login?.state === 'waiting' || this.login?.state === 'checking') return this.loginState();
    // `script` gives the CLI the terminal it expects; a wide terminal keeps the link on one line.
    const cmd = `stty cols 2000 2>/dev/null; exec ${shellQuote(this.claudeBin)} auth login --claudeai`;
    const proc = spawn('script', ['-q', '-f', '-c', cmd, '/dev/null'], {
      env: this.childEnv({ BROWSER: 'true', TERM: 'xterm-256color' }), stdio: ['pipe', 'pipe', 'pipe'],
    });
    const login = { proc, output: '', url: null, state: 'waiting', error: null };
    this.login = login;
    const onData = (d) => {
      login.output = (login.output + d).slice(-20000);
      login.url ||= URL_RE.exec(login.output)?.[0] || null;
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => {
      login.state = 'error';
      login.error = err.code === 'ENOENT' ? 'Falta el programa "script" (util-linux) en este Linux' : err.message;
    });
    proc.on('close', async (code) => {
      if (login.state === 'error') return;
      this.cache = null;
      const s = await this.status({ fresh: true });
      login.state = s.loggedIn ? 'done' : 'error';
      if (!s.loggedIn) login.error = lastLines(login.output) || `El inicio de sesión terminó (código ${code})`;
    });
    return this.loginState();
  }

  sendCode(code) {
    const login = this.login;
    if (!login || login.state !== 'waiting') throw Object.assign(new Error('No hay un inicio de sesión en curso'), { status: 409 });
    code = String(code || '').trim();
    if (!code) throw Object.assign(new Error('Pega el código que te dio Claude'), { status: 400 });
    login.state = 'checking';
    login.proc.stdin.write(`${code}\r`);
    // If the CLI rejects the code it may keep waiting; give up after a while.
    setTimeout(() => { if (login.state === 'checking') login.proc.kill(); }, 60000).unref();
    return this.loginState();
  }

  cancelLogin() {
    this.login?.proc.kill();
    this.login = null;
  }

  loginState() {
    const l = this.login;
    return l ? { state: l.state, url: l.url, error: l.error } : { state: 'idle' };
  }
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function lastLines(out) {
  return out.replace(ANSI_RE, '').split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean).slice(-3).join(' · ').slice(0, 300);
}
