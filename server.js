#!/usr/bin/env node
// Bolsillo: a pocket workshop. Serves the mobile UI, drives Claude Code per project,
// runs the resulting apps and exposes the phone's hardware.
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Projects } from './lib/projects.js';
import { Runner } from './lib/runner.js';
import { runTurn } from './lib/agent.js';
import { serveStatic } from './lib/static.js';
import { listCapabilities, callCapability, onAndroid } from './lib/device.js';
import { ClaudeAccount } from './lib/claude.js';
import { memInfo, topProcesses, tail, runDiag, diagState } from './lib/sysinfo.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp({
  dataDir = process.env.BOLSILLO_DATA || path.join(here, 'data'),
  host = process.env.HOST || '127.0.0.1',
  basePort = Number(process.env.BOLSILLO_APPS_PORT || 7701),
  claudeBin = process.env.CLAUDE_BIN || 'claude',
  token = process.env.BOLSILLO_TOKEN || (host === '127.0.0.1' ? '' : crypto.randomBytes(12).toString('hex')),
  // Behind a gateway apps are reached by path instead of port, e.g. "/p/{port}/".
  appBase = process.env.BOLSILLO_APP_BASE || '',
} = {}) {
  const appLink = (reqHost, port) => appBase
    ? appBase.replace('{port}', port)
    : `http://${reqHost?.split(':')[0] || '127.0.0.1'}:${port}/`;
  const projects = new Projects({ dataDir, templatesDir: path.join(here, 'templates') });
  const runner = new Runner({ basePort, host });
  const turns = new Map(); // project id -> running agent child
  const account = new ClaudeAccount({ claudeBin, dataDir });

  const routes = [
    ['GET', /^\/api\/info$/, async () => {
      const [claude, device] = await Promise.all([account.status({ wait: false }), listCapabilities()]);
      return { claude: claude.version && `${claude.version} (Claude Code)`, account: claude, android: onAndroid(), host, device, appBase };
    }],
    ['GET', /^\/api\/health$/, () => ({
      ...memInfo(), load: os.loadavg()[0], cpus: os.cpus().length, uptime: Math.round(os.uptime()),
      serverMB: Math.round(process.memoryUsage().rss / 1048576),
      running: projects.list().filter((p) => runner.status(p.id).running).length, busy: turns.size, top: topProcesses(),
    })],
    // Debug view (Safari build): logs listed in BOLSILLO_DEBUG_LOGS and the self-test in BOLSILLO_DIAG_CMD.
    ['GET', /^\/api\/debug$/, () => ({
      diag: diagState(),
      logs: Object.fromEntries((process.env.BOLSILLO_DEBUG_LOGS || '').split(',').filter(Boolean).map((f) => [f, tail(f)])),
    })],
    ['POST', /^\/api\/debug\/diag$/, () => runDiag(process.env.BOLSILLO_DIAG_CMD)],
    // Safari build: the console is a serial port, so Linux doesn't know the size of the page's terminal.
    // The page sends it; stty applies it to BOLSILLO_TTY and the kernel tells the program there (SIGWINCH).
    ['POST', /^\/api\/debug\/tty$/, (_, body) => {
      const tty = process.env.BOLSILLO_TTY, cols = Number(body.cols), rows = Number(body.rows);
      if (!tty) throw httpError(404, 'No terminal to resize');
      if (!(cols >= 20 && cols <= 500 && rows >= 5 && rows <= 300)) throw httpError(400, 'Odd size');
      return new Promise((resolve) => execFile('stty', ['-F', tty, 'cols', String(cols), 'rows', String(rows)], (err) => resolve({ ok: !err, cols, rows, error: err?.message })));
    }],
    ['GET', /^\/api\/claude$/, () => account.status({ fresh: true })],
    ['POST', /^\/api\/claude\/key$/, (_, body) => { account.saveKey(body.key); return account.status({ fresh: true }); }],
    ['DELETE', /^\/api\/claude\/key$/, () => { account.forgetKey(); return account.status({ fresh: true }); }],
    ['POST', /^\/api\/claude\/login$/, () => account.startLogin()],
    ['GET', /^\/api\/claude\/login$/, () => account.loginState()],
    ['POST', /^\/api\/claude\/login\/code$/, (_, body) => account.sendCode(body.code)],
    ['DELETE', /^\/api\/claude\/login$/, () => { account.cancelLogin(); return { ok: true }; }],
    ['POST', /^\/api\/shell$/, (_, body) => shell(String(body.cmd || ''), body.cwd ? projects.dir(body.cwd) : dataDir)],
    ['GET', /^\/api\/templates$/, () => projects.listTemplates()],
    ['GET', /^\/api\/projects$/, () => projects.list().map((p) => ({ ...p, ...runner.status(p.id), busy: turns.has(p.id) }))],
    ['POST', /^\/api\/projects$/, (_, body) => {
      if (!body.name?.trim()) throw httpError(400, 'The name is missing');
      return projects.create({ name: body.name.trim(), template: body.template, idea: body.idea || '' });
    }],
    ['GET', /^\/api\/projects\/([\w-]+)$/, (m) => {
      const p = mustGet(m[1]);
      return { ...p, ...runner.status(p.id), busy: turns.has(p.id), chat: projects.chat(p.id), history: projects.history(p.id) };
    }],
    ['DELETE', /^\/api\/projects\/([\w-]+)$/, (m) => {
      mustGet(m[1]);
      runner.stop(m[1]);
      turns.get(m[1])?.kill();
      projects.remove(m[1]);
      return { ok: true };
    }],
    ['POST', /^\/api\/projects\/([\w-]+)\/run$/, (m) => {
      const p = mustGet(m[1]);
      return runner.start(p.id, projects.dir(p.id), p);
    }],
    ['POST', /^\/api\/projects\/([\w-]+)\/stop$/, (m) => { runner.stop(m[1]); return { ok: true }; }],
    ['POST', /^\/api\/projects\/([\w-]+)\/undo$/, (m) => {
      mustGet(m[1]);
      if (turns.has(m[1])) throw httpError(409, 'Wait for Claude to finish');
      projects.undo(m[1]);
      projects.appendChat(m[1], { role: 'system', text: 'The last change was undone.' });
      return { ok: true };
    }],
    ['POST', /^\/api\/projects\/([\w-]+)\/cancel$/, (m) => { turns.get(m[1])?.kill(); return { ok: true }; }],
    ['GET', /^\/api\/device$/, () => listCapabilities()],
    ['POST', /^\/api\/device\/(\w+)$/, (m, body) => callCapability(m[1], body)],
  ];

  function mustGet(id) {
    const p = projects.get(id);
    if (!p) throw httpError(404, 'Project not found');
    return p;
  }

  // Streams one agent turn to the client as Server-Sent Events.
  function chat(id, body, res) {
    const p = mustGet(id);
    const message = String(body.message || '').trim();
    if (!message) throw httpError(400, 'Empty message');
    if (turns.has(id)) throw httpError(409, 'Claude is already working on this project');

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    projects.appendChat(id, { role: 'user', text: message });

    const steps = [];
    let reply = '';
    const { child, done } = runTurn({
      cwd: projects.dir(id), prompt: message, sessionId: p.sessionId, freeMode: !!body.free, claudeBin, env: account.env(),
      onEvent(ev) {
        if (ev.type === 'session') projects.setState(id, { sessionId: ev.sessionId });
        if (ev.type === 'tool') steps.push(ev.label);
        if (ev.type === 'text') reply += (reply ? '\n\n' : '') + ev.text;
        if (ev.type === 'done') {
          if (ev.sessionId) projects.setState(id, { sessionId: ev.sessionId });
          const committed = projects.snapshot(id, message);
          projects.setState(id, { updatedAt: Date.now() });
          projects.appendChat(id, { role: 'assistant', text: reply || ev.error || '', steps, ok: ev.ok });
          ev.changed = committed;
        }
        send(ev);
      },
    });
    turns.set(id, child);
    res.on('close', () => { /* keep working even if the phone screen turns off */ });
    done.then(() => { turns.delete(id); res.end(); });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (token && !authorized(req, url, token)) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }).end('Missing token: open the URL Bolsillo showed when it started.');
        return;
      }
      if (token && url.searchParams.get('token') === token) {
        res.setHeader('set-cookie', `bolsillo=${token}; HttpOnly; SameSite=Strict; Path=/`);
      }
      // /launch/<id>: start an app and jump to it (home-screen shortcuts open this).
      const launch = /^\/launch\/([\w-]+)\/?$/.exec(url.pathname);
      if (launch && req.method === 'GET') {
        const p = mustGet(launch[1]);
        const { port } = await runner.start(p.id, projects.dir(p.id), p);
        res.writeHead(302, { location: appLink(req.headers.host, port) }).end();
        return;
      }
      if (!url.pathname.startsWith('/api/')) return serveStatic(path.join(here, 'public'), req, res);

      const chatMatch = /^\/api\/projects\/([\w-]+)\/chat$/.exec(url.pathname);
      if (req.method === 'POST' && chatMatch) return chat(chatMatch[1], await readBody(req), res);

      for (const [method, re, handler] of routes) {
        const m = re.exec(url.pathname);
        if (m && req.method === method) {
          const result = await handler(m, method === 'POST' ? await readBody(req) : {});
          return json(res, 200, result);
        }
      }
      json(res, 404, { error: 'Route not found' });
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      json(res, err.status || 500, { error: err.message });
    }
  });

  // A tiny Linux console for the settings screen: runs one command, returns its output.
  function shell(cmd, cwd) {
    if (!cmd.trim()) throw httpError(400, 'Type a command');
    return new Promise((resolve) => {
      execFile('sh', ['-c', cmd], { cwd, timeout: 120000, maxBuffer: 1 << 20, env: account.childEnv() }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, output: `${stdout}${stderr}`.slice(-20000) || (err && !err.code ? err.message : '') });
      });
    });
  }

  return { server, projects, runner, account, token, host, close() { runner.stopAll(); account.cancelLogin(); for (const c of turns.values()) c.kill(); server.close(); } };
}

function authorized(req, url, token) {
  if (url.searchParams.get('token') === token) return true;
  if (req.headers.authorization === `Bearer ${token}`) return true;
  return (req.headers.cookie || '').split(/;\s*/).includes(`bolsillo=${token}`);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(httpError(400, 'Invalid JSON')); } });
    req.on('error', reject);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 7700);
  const app = createApp();
  app.server.listen(port, app.host, () => {
    const shown = app.host === '0.0.0.0' ? 'PHONE-IP' : app.host;
    console.log(`\n  Bolsillo ready → http://${shown}:${port}/${app.token ? `?token=${app.token}` : ''}\n`);
  });
  const shutdown = () => { app.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
