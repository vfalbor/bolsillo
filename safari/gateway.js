// Bolsillo gateway for Safari: a single origin for
//   /vm/…        the page with the aarch64 Linux (QEMU in WebAssembly)
//   /net         the network relay: WebSocket → c2w-net (TCP/IP stack on the host; TLS stays end to end)
//   /p/<port>/   the apps running inside Linux
//   /…           the Bolsillo panel running inside Linux
// Every response carries COOP/COEP (it's the only way Safari gives SharedArrayBuffer) and requires the token.
// No dependencies.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.GATEWAY_TOKEN || crypto.randomBytes(12).toString('hex');
const RELAY = { host: '127.0.0.1', port: Number(process.env.RELAY_PORT || 8888) };
// c2w-net publishes each Linux port on the host as PORT_OFFSET + port (7700 → 17700).
const PORT_OFFSET = Number(process.env.PORT_OFFSET || 10000);
const hostPortFor = (guestPort) => PORT_OFFSET + guestPort;
const PANEL_PORT = 7700;
const GUEST_TOKEN = process.env.BOLSILLO_TOKEN || 'safari';
const STATIC_DIRS = (process.env.HTDOCS || `${here}/web:${here}/build/base/htdocs`).split(':');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.data': 'application/octet-stream',
};

function isolation(headers = {}) {
  return {
    ...headers,
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-resource-policy': 'same-origin',
  };
}

function authorized(req, url) {
  if (url.searchParams.get('t') === TOKEN) return 'query';
  const cookie = req.headers.cookie || '';
  return cookie.split(/;\s*/).includes(`bolsillo_gw=${TOKEN}`) ? 'cookie' : null;
}

function serveStatic(req, res, rel) {
  rel = decodeURIComponent(rel || '/');
  if (rel.endsWith('/')) rel += 'index.html';
  rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  for (const dir of STATIC_DIRS) {
    const file = path.join(dir, rel);
    if (!file.startsWith(path.resolve(dir))) continue;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const headers = isolation({ 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', 'accept-ranges': 'bytes' });
    const size = fs.statSync(file).size;
    // Ranges: the Linux disk is requested in chunks (web/lazy-load.js).
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]), end = Math.min(size - 1, range[2] ? Number(range[2]) : size - 1);
      if (start > end) { res.writeHead(416, isolation({ 'content-range': `bytes */${size}` })).end(); return; }
      // Chunks don't change unless the file does: let the browser keep them.
      headers['cache-control'] = 'private, max-age=86400';
      headers['content-range'] = `bytes ${start}-${end}/${size}`;
      headers['content-length'] = end - start + 1;
      res.writeHead(206, headers);
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    // Big precompressed files (out.wasm.gz, out.data.gz…): less to download and less network memory.
    const gz = `${file}.gz`;
    // (only if it's at least as new as the original: an old .gz next to a new file would break the page)
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && fs.existsSync(gz) && fs.statSync(gz).mtimeMs >= fs.statSync(file).mtimeMs) {
      headers['content-encoding'] = 'gzip';
      headers['content-length'] = fs.statSync(gz).size;
      res.writeHead(200, headers);
      return fs.createReadStream(gz).pipe(res);
    }
    headers['content-length'] = size;
    res.writeHead(200, headers);
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404, isolation({ 'content-type': 'text/plain; charset=utf-8' })).end('Not found');
}

// Compressed disk chunks: GET /vm/z/<.data file>?s=<start>&e=<end> → [s, e) in brotli (or gzip).
// The disk shrinks to ~1/3 and, since the file name carries a version, the browser can keep it forever
// (the second visit downloads almost nothing). Compressed chunks are kept in build/zcache.
const ZCACHE = process.env.ZCACHE || path.join(here, 'build', 'zcache');
async function serveZ(req, res, name, url) {
  const s = Number(url.searchParams.get('s')), e = Number(url.searchParams.get('e'));
  const file = STATIC_DIRS.map((d) => path.join(d, name)).find((f) => /^[\w.-]+\.data$/.test(name) && fs.existsSync(f));
  if (!file || !(Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e > s && e - s <= 128 << 20 && e <= fs.statSync(file).size)) {
    res.writeHead(400, isolation({ 'content-type': 'text/plain; charset=utf-8' })).end('Invalid chunk'); return;
  }
  const accept = req.headers['accept-encoding'] || '';
  const enc = /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
  const headers = isolation({ 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable' });
  const raw = () => new Promise((ok, ko) => fs.open(file, 'r', (err, fd) => {
    if (err) return ko(err);
    const b = Buffer.alloc(e - s);
    fs.read(fd, b, 0, b.length, s, (err2) => { fs.close(fd, () => {}); err2 ? ko(err2) : ok(b); });
  }));
  try {
    if (!enc) { const b = await raw(); res.writeHead(200, { ...headers, 'content-length': b.length }).end(b); return; }
    const cached = path.join(ZCACHE, name, `${s}-${e}.${enc}`);
    let body = fs.existsSync(cached) ? fs.readFileSync(cached) : null;
    if (!body) {
      const b = await raw();
      body = await new Promise((ok, ko) => enc === 'br'
        ? zlib.brotliCompress(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length } }, (err, z) => err ? ko(err) : ok(z))
        : zlib.gzip(b, { level: 6 }, (err, z) => err ? ko(err) : ok(z)));
      fs.mkdirSync(path.dirname(cached), { recursive: true });
      fs.writeFile(`${cached}.tmp`, body, (err) => { if (!err) fs.rename(`${cached}.tmp`, cached, () => {}); });
    }
    res.writeHead(200, { ...headers, 'content-encoding': enc, 'content-length': body.length, 'x-bolsillo-raw': e - s }).end(body);
  } catch (err) {
    if (!res.headersSent) res.writeHead(500, isolation({ 'content-type': 'text/plain; charset=utf-8' })).end(String(err.message));
  }
}

function proxy(req, res, port, pathAndQuery) {
  const headers = { ...req.headers, host: `127.0.0.1:${port}`, authorization: `Bearer ${GUEST_TOKEN}` };
  delete headers.cookie;
  const up = http.request({ host: '127.0.0.1', port: hostPortFor(port), method: req.method, path: pathAndQuery, headers }, (r) => {
    const h = isolation({ ...r.headers });
    // Linux redirects to http://<host>:<port>/ → the same path under /p/<port>/.
    if (h.location) h.location = h.location.replace(/^https?:\/\/[^/]+:(\d+)\//, (_, p) => `/p/${p}/`);
    delete h['set-cookie'];
    res.writeHead(r.statusCode, h);
    r.pipe(res);
  });
  up.setTimeout(0);
  up.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, isolation({ 'content-type': 'text/plain; charset=utf-8' })).end("Linux isn't answering on that port yet");
  });
  req.pipe(up);
}

// What the page asks Linux to monitor it (health, debug) costs it CPU, a lot in the emulator: answered
// from a 15 s cache, with a single question in flight per route.
const MONITORED = new Set(['/api/health', '/api/debug']);
const monitorCache = new Map(); // route → { at, status, body, waiting: [res] | null }
function cachedProxy(req, res, route) {
  const c = monitorCache.get(route);
  const send = (r, e) => r.writeHead(e.status, isolation({ 'content-type': 'application/json', 'cache-control': 'no-store', 'x-bolsillo-cache': e.hit ? 'hit' : 'miss' })).end(e.body);
  if (c?.body && Date.now() - c.at < 15000) return send(res, { ...c, hit: true });
  if (c?.waiting) { c.waiting.push(res); return; }
  const entry = { ...(c || {}), waiting: [res] };
  monitorCache.set(route, entry);
  const headers = { host: `127.0.0.1:${PANEL_PORT}`, authorization: `Bearer ${GUEST_TOKEN}` };
  const done = (status, body) => {
    const waiting = entry.waiting; entry.waiting = null;
    if (status === 200) Object.assign(entry, { at: Date.now(), status, body });
    for (const r of waiting) send(r, { status, body });
  };
  const up = http.get({ host: '127.0.0.1', port: hostPortFor(PANEL_PORT), path: route, headers }, (r) => {
    let body = ''; r.setEncoding('utf8');
    r.on('data', (d) => { body += d; });
    r.on('end', () => done(r.statusCode, body));
  });
  up.setTimeout(120000, () => up.destroy());
  up.on('error', () => done(502, JSON.stringify({ error: "Linux isn't answering yet" })));
}

// Page reports (milestones, disk, errors) to see from here how a test on the iPhone went.
const REPORTS = process.env.REPORTS || path.join(here, 'results', 'reports.jsonl');
function saveReport(req, res) {
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 60000) req.destroy(); /* sendBeacon allows up to 64 KB */ });
  req.on('end', () => {
    try {
      const r = JSON.parse(body);
      fs.mkdirSync(path.dirname(REPORTS), { recursive: true });
      fs.appendFileSync(REPORTS, JSON.stringify({ at: new Date().toISOString(), ip: req.headers['x-real-ip'] || req.socket.remoteAddress, ...r }) + '\n');
    } catch {}
    res.writeHead(204, isolation()).end();
  });
}

// Claude sign-in (Pro/Max subscription) done by the server, without waiting for Linux to boot: the same
// flow as "claude setup-token" (OAuth with PKCE, Claude Code's client, user:inference scope, one-year
// token), with the "manual" redirect that shows a code to paste.
//   GET  /vm/login                → { url, state }   claude.ai link to authorize
//   POST /vm/login {state, code}  → { token }        the code claude.ai shows, exchanged for the token
// The PKCE verifier stays here; the token is never stored or logged anywhere.
const OAUTH = {
  authorize: 'https://claude.com/cai/oauth/authorize',
  token: 'https://platform.claude.com/v1/oauth/token',
  redirect: 'https://platform.claude.com/oauth/code/callback',
  client: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
};
const logins = new Map(); // state → { verifier, at }
const b64url = (buf) => buf.toString('base64url');
function login(req, res) {
  const json = (code, body) => res.writeHead(code, isolation({ 'content-type': 'application/json', 'cache-control': 'no-store' })).end(JSON.stringify(body));
  for (const [k, v] of logins) if (Date.now() - v.at > 30 * 60e3) logins.delete(k);
  if (req.method === 'GET') {
    const verifier = b64url(crypto.randomBytes(32)), state = b64url(crypto.randomBytes(32));
    logins.set(state, { verifier, at: Date.now() });
    const u = new URL(OAUTH.authorize);
    for (const [k, v] of Object.entries({ code: 'true', client_id: OAUTH.client, response_type: 'code', redirect_uri: OAUTH.redirect,
      scope: 'user:inference', code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state }))
      u.searchParams.append(k, v);
    return json(200, { url: u.toString(), state });
  }
  if (req.method !== 'POST') return json(405, { error: 'method' });
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 8000) req.destroy(); });
  req.on('end', async () => {
    try {
      const { state, code: pasted } = JSON.parse(body);
      // claude.ai shows "code#state": keep the code, and the state (if present) wins.
      const [code, st = state] = String(pasted || '').trim().split('#');
      const L = logins.get(st);
      if (!L || !code) return json(400, { error: "The link has expired or the code isn't from this link: open it again." });
      const r = await fetch(OAUTH.token, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: OAUTH.redirect, client_id: OAUTH.client,
          code_verifier: L.verifier, state: st, expires_in: 31536000 }),
      });
      const t = await r.json().catch(() => ({}));
      if (r.status !== 200 || !t.access_token) {
        console.log(`login: claude.ai answers ${r.status} ${t.error || ''}`);
        return json(400, { error: r.status === 400 || r.status === 401 ? "That code isn't valid (or was already used): open the link again and paste the new code." : `claude.ai isn't answering properly (${r.status}).` });
      }
      logins.delete(st);
      console.log('login: subscription token handed to the page');
      json(200, { token: t.access_token });
    } catch (e) { json(502, { error: `Couldn't talk to claude.ai: ${e.message}` }); }
  });
}

// Backup of each iPhone's apps (Linux's projects folder, as .tar.gz): the Linux disk is lost when the page
// reloads, so Linux uploads it here when it changes and restores it at boot. The page makes up the key at
// random and keeps it on the iPhone; whoever has it has the backup (that's why it doesn't ask for the token).
const DATA_DIR = process.env.DATA_DIR || path.join(here, 'data');
function backup(req, res, key) {
  const file = path.join(DATA_DIR, `${key}.tgz`);
  if (req.method === 'GET') {
    fs.stat(file, (err, st) => {
      if (err) { res.writeHead(404, isolation()).end(); return; }
      res.writeHead(200, isolation({ 'content-type': 'application/gzip', 'content-length': st.size, 'cache-control': 'no-store' }));
      fs.createReadStream(file).pipe(res);
    });
    return;
  }
  if (req.method !== 'PUT') { res.writeHead(405, isolation()).end(); return; }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}`;
  const out = fs.createWriteStream(tmp);
  let size = 0;
  req.on('data', (d) => { size += d.length; if (size > 64 << 20) { req.destroy(); out.destroy(); fs.rm(tmp, () => {}); } });
  req.pipe(out);
  out.on('finish', () => {
    if (size < 20) { fs.rm(tmp, () => {}); res.writeHead(400, isolation()).end(); return; }
    fs.rename(tmp, file, () => res.writeHead(204, isolation()).end());
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const dk = /^\/vm\/data\/([A-Za-z0-9_-]{32,64})$/.exec(url.pathname);
  if (dk) return backup(req, res, dk[1]);
  const auth = authorized(req, url);
  if (!auth) {
    res.writeHead(401, isolation({ 'content-type': 'text/plain; charset=utf-8' })).end('Missing token: open the full link you were given.');
    return;
  }
  if (auth === 'query') {
    res.setHeader('set-cookie', `bolsillo_gw=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
    url.searchParams.delete('t');
    res.writeHead(302, isolation({ location: url.pathname + (url.search || '') })).end();
    return;
  }
  if (url.pathname === '/vm' ) { res.writeHead(302, isolation({ location: '/vm/' })).end(); return; }
  if (url.pathname === '/vm/report' && req.method === 'POST') return saveReport(req, res);
  if (url.pathname === '/vm/net-owner') {
    const sid = url.searchParams.get('sid') || '';
    res.writeHead(200, isolation({ 'content-type': 'application/json', 'cache-control': 'no-store' }));
    res.end(JSON.stringify({ owner: netOwner.sid === sid, displaced: displaced.has(sid) }));
    return;
  }
  if (url.pathname === '/vm/login') return login(req, res);
  if (url.pathname.startsWith('/vm/z/')) return serveZ(req, res, url.pathname.slice(6), url);
  // Claude sign-in link: the page opens it through here (a redirect from this server) so iOS opens it in
  // Safari and not in the Claude app, which doesn't show the code to paste.
  if (url.pathname === '/vm/go') {
    const to = url.searchParams.get('u') || '';
    let ok = false;
    try { ok = /^(claude\.ai|claude\.com|platform\.claude\.com|console\.anthropic\.com)$/.test(new URL(to).hostname) && to.startsWith('https://'); } catch {}
    res.writeHead(ok ? 302 : 400, isolation(ok ? { location: to, 'cache-control': 'no-store' } : { 'content-type': 'text/plain; charset=utf-8' })).end(ok ? '' : 'Link not allowed');
    return;
  }
  if (url.pathname.startsWith('/vm/')) return serveStatic(req, res, url.pathname.slice(4));
  const app = /^\/p\/(\d{4,5})(\/.*)?$/.exec(url.pathname);
  if (app) {
    if (!app[2]) { res.writeHead(302, isolation({ location: `${url.pathname}/` })).end(); return; }
    return proxy(req, res, Number(app[1]), app[2] + url.search);
  }
  if (req.method === 'GET' && MONITORED.has(url.pathname)) return cachedProxy(req, res, url.pathname);
  return proxy(req, res, PANEL_PORT, url.pathname + url.search);
});

// Relay: the page speaks WebSocket to /net and we pass it on as is to c2w-net.
// c2w-net only carries one Linux's network: it belongs to the tab that opened it last. Each page sends
// its session id (?sid=); when a new one arrives the previous one is cut off and can't come back (it
// checks /vm/net-owner and says so on screen instead of fighting over the network).
let netOwner = { sid: null, sockets: new Set() };
const displaced = new Set();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/net' || !authorized(req, url)) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
  const sid = url.searchParams.get('sid') || '';
  if (displaced.has(sid)) { socket.end('HTTP/1.1 409 Conflict\r\n\r\n'); return; }
  if (netOwner.sid !== sid) {
    if (netOwner.sid !== null) {
      displaced.add(netOwner.sid);
      for (const s of netOwner.sockets) s.destroy();
      console.log(`network: session ${sid || '(no id)'} replaces ${netOwner.sid || '(no id)'}`);
    }
    netOwner = { sid, sockets: new Set() };
  }
  netOwner.sockets.add(socket);
  socket.on('close', () => netOwner.sockets.delete(socket));
  const up = net.connect(RELAY, () => {
    const lines = [`GET / HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      if (/^(host|cookie|origin)$/i.test(k)) continue;
      lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
    }
    lines.push(`Host: ${RELAY.host}:${RELAY.port}`);
    // c2w-net rejects (403) a WebSocket without Origin; the gateway has already checked the token.
    lines.push(`Origin: http://${RELAY.host}:${RELAY.port}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  const close = () => { socket.destroy(); up.destroy(); };
  up.on('error', close);
  socket.on('error', close);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Bolsillo for Safari → http://${HOST}:${PORT}/vm/?t=${TOKEN}\n`);
});
