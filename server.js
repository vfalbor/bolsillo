#!/usr/bin/env node
// Bolsillo: a pocket workshop. Serves the mobile UI, drives Claude Code per project,
// runs the resulting apps and exposes the phone's hardware.
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Projects } from './lib/projects.js';
import { Runner } from './lib/runner.js';
import { runTurn } from './lib/agent.js';
import { serveStatic } from './lib/static.js';
import { listCapabilities, callCapability, onAndroid } from './lib/device.js';
import { ClaudeAccount } from './lib/claude.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp({
  dataDir = process.env.BOLSILLO_DATA || path.join(here, 'data'),
  host = process.env.HOST || '127.0.0.1',
  basePort = Number(process.env.BOLSILLO_APPS_PORT || 7701),
  claudeBin = process.env.CLAUDE_BIN || 'claude',
  token = process.env.BOLSILLO_TOKEN || (host === '127.0.0.1' ? '' : crypto.randomBytes(12).toString('hex')),
} = {}) {
  const projects = new Projects({ dataDir, templatesDir: path.join(here, 'templates') });
  const runner = new Runner({ basePort, host });
  const turns = new Map(); // project id -> running agent child
  const account = new ClaudeAccount({ claudeBin, dataDir });

  const routes = [
    ['GET', /^\/api\/info$/, async () => {
      const [claude, device] = await Promise.all([account.status(), listCapabilities()]);
      return { claude: claude.version && `${claude.version} (Claude Code)`, account: claude, android: onAndroid(), host, device };
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
      if (!body.name?.trim()) throw httpError(400, 'Falta el nombre');
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
      if (turns.has(m[1])) throw httpError(409, 'Espera a que Claude termine');
      projects.undo(m[1]);
      projects.appendChat(m[1], { role: 'system', text: 'Se deshizo el último cambio.' });
      return { ok: true };
    }],
    ['POST', /^\/api\/projects\/([\w-]+)\/cancel$/, (m) => { turns.get(m[1])?.kill(); return { ok: true }; }],
    ['GET', /^\/api\/device$/, () => listCapabilities()],
    ['POST', /^\/api\/device\/(\w+)$/, (m, body) => callCapability(m[1], body)],
  ];

  function mustGet(id) {
    const p = projects.get(id);
    if (!p) throw httpError(404, 'Proyecto no encontrado');
    return p;
  }

  // Streams one agent turn to the client as Server-Sent Events.
  function chat(id, body, res) {
    const p = mustGet(id);
    const message = String(body.message || '').trim();
    if (!message) throw httpError(400, 'Mensaje vacío');
    if (turns.has(id)) throw httpError(409, 'Claude ya está trabajando en este proyecto');

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
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }).end('Falta el token: abre la URL que mostró Bolsillo al arrancar.');
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
        res.writeHead(302, { location: `http://${req.headers.host?.split(':')[0] || '127.0.0.1'}:${port}/` }).end();
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
      json(res, 404, { error: 'Ruta no encontrada' });
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      json(res, err.status || 500, { error: err.message });
    }
  });

  // A tiny Linux console for the settings screen: runs one command, returns its output.
  function shell(cmd, cwd) {
    if (!cmd.trim()) throw httpError(400, 'Escribe un comando');
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
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(httpError(400, 'JSON inválido')); } });
    req.on('error', reject);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 7700);
  const app = createApp();
  app.server.listen(port, app.host, () => {
    const shown = app.host === '0.0.0.0' ? 'IP-DEL-MOVIL' : app.host;
    console.log(`\n  Bolsillo listo → http://${shown}:${port}/${app.token ? `?token=${app.token}` : ''}\n`);
  });
  const shutdown = () => { app.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
