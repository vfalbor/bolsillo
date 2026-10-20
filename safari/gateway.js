// Puerta de Bolsillo en Safari: un único origen para
//   /vm/…        la página con el Linux aarch64 (QEMU en WebAssembly)
//   /net         el relé de red: WebSocket → c2w-net (pila TCP/IP en el host; el TLS va de extremo a extremo)
//   /p/<puerto>/ las apps que corren dentro del Linux
//   /…           el panel de Bolsillo que corre dentro del Linux
// Todas las respuestas llevan COOP/COEP (Safari solo da SharedArrayBuffer así) y exigen el token.
// Sin dependencias.
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
// c2w-net publica cada puerto del Linux en el host como PORT_OFFSET + puerto (7700 → 17700).
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
    // Por partes: el disco del Linux se pide a trozos (web/lazy-load.js).
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]), end = Math.min(size - 1, range[2] ? Number(range[2]) : size - 1);
      if (start > end) { res.writeHead(416, isolation({ 'content-range': `bytes */${size}` })).end(); return; }
      // Los trozos no cambian mientras no cambie el fichero: que el navegador los guarde.
      headers['cache-control'] = 'private, max-age=86400';
      headers['content-range'] = `bytes ${start}-${end}/${size}`;
      headers['content-length'] = end - start + 1;
      res.writeHead(206, headers);
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    // Ficheros grandes precomprimidos (out.wasm.gz, out.data.gz…): menos descarga y menos memoria de red.
    const gz = `${file}.gz`;
    // (solo si es al menos tan nuevo como el original: un .gz viejo junto a un fichero nuevo rompería la página)
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
  res.writeHead(404, isolation({ 'content-type': 'text/plain; charset=utf-8' })).end('No encontrado');
}

// Trozos del disco comprimidos: GET /vm/z/<fichero .data>?s=<inicio>&e=<fin> → [s, e) en brotli (o gzip).
// El disco baja a ~1/3 y, como el nombre del fichero lleva versión, el navegador puede guardarlo para
// siempre (la segunda visita casi no descarga). Lo comprimido se guarda en build/zcache.
const ZCACHE = process.env.ZCACHE || path.join(here, 'build', 'zcache');
async function serveZ(req, res, name, url) {
  const s = Number(url.searchParams.get('s')), e = Number(url.searchParams.get('e'));
  const file = STATIC_DIRS.map((d) => path.join(d, name)).find((f) => /^[\w.-]+\.data$/.test(name) && fs.existsSync(f));
  if (!file || !(Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e > s && e - s <= 128 << 20 && e <= fs.statSync(file).size)) {
    res.writeHead(400, isolation({ 'content-type': 'text/plain; charset=utf-8' })).end('Trozo no válido'); return;
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
    // Redirecciones del Linux a http://<host>:<puerto>/ → la misma ruta bajo /p/<puerto>/.
    if (h.location) h.location = h.location.replace(/^https?:\/\/[^/]+:(\d+)\//, (_, p) => `/p/${p}/`);
    delete h['set-cookie'];
    res.writeHead(r.statusCode, h);
    r.pipe(res);
  });
  up.setTimeout(0);
  up.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, isolation({ 'content-type': 'text/plain; charset=utf-8' })).end('El Linux aún no responde en ese puerto');
  });
  req.pipe(up);
}

// Lo que la página pregunta al Linux para vigilarlo (salud, depuración) le cuesta CPU, y en el emulador
// mucha: se responde de una caché de 15 s, con una sola pregunta en vuelo por ruta.
const MONITORED = new Set(['/api/health', '/api/debug']);
const monitorCache = new Map(); // ruta → { at, status, body, waiting: [res] | null }
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
  up.on('error', () => done(502, JSON.stringify({ error: 'El Linux aún no responde' })));
}

// Informes de la página (hitos, disco, errores) para ver desde aquí cómo fue una prueba en el iPhone.
const REPORTS = process.env.REPORTS || path.join(here, 'results', 'reports.jsonl');
function saveReport(req, res) {
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 60000) req.destroy(); /* sendBeacon admite hasta 64 KB */ });
  req.on('end', () => {
    try {
      const r = JSON.parse(body);
      fs.mkdirSync(path.dirname(REPORTS), { recursive: true });
      fs.appendFileSync(REPORTS, JSON.stringify({ at: new Date().toISOString(), ip: req.headers['x-real-ip'] || req.socket.remoteAddress, ...r }) + '\n');
    } catch {}
    res.writeHead(204, isolation()).end();
  });
}

// Inicio de sesión de Claude (suscripción Pro/Max) hecho por el servidor, sin esperar a que arranque el
// Linux: es el mismo flujo que «claude setup-token» (OAuth con PKCE, cliente de Claude Code, permiso
// user:inference, token de un año), con la redirección «manual» que enseña un código para pegar.
//   GET  /vm/login                → { url, state }   enlace de claude.ai para autorizar
//   POST /vm/login {state, code}  → { token }        el código que enseña claude.ai, cambiado por el token
// El verificador PKCE se queda aquí; el token no se guarda ni se apunta en ningún sitio.
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
  if (req.method !== 'POST') return json(405, { error: 'método' });
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 8000) req.destroy(); });
  req.on('end', async () => {
    try {
      const { state, code: pasted } = JSON.parse(body);
      // claude.ai enseña «código#estado»: se queda el código, y el estado (si viene) manda.
      const [code, st = state] = String(pasted || '').trim().split('#');
      const L = logins.get(st);
      if (!L || !code) return json(400, { error: 'El enlace ha caducado o el código no es de este enlace: ábrelo otra vez.' });
      const r = await fetch(OAUTH.token, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: OAUTH.redirect, client_id: OAUTH.client,
          code_verifier: L.verifier, state: st, expires_in: 31536000 }),
      });
      const t = await r.json().catch(() => ({}));
      if (r.status !== 200 || !t.access_token) {
        console.log(`login: claude.ai contesta ${r.status} ${t.error || ''}`);
        return json(400, { error: r.status === 400 || r.status === 401 ? 'Ese código no vale (o ya se usó): abre el enlace otra vez y pega el código nuevo.' : `claude.ai no responde bien (${r.status}).` });
      }
      logins.delete(st);
      console.log('login: token de suscripción entregado a la página');
      json(200, { token: t.access_token });
    } catch (e) { json(502, { error: `No se pudo hablar con claude.ai: ${e.message}` }); }
  });
}

// Copia de las apps de cada iPhone (carpeta projects del Linux, en .tar.gz): el disco del Linux se pierde al
// recargar la página, así que el Linux la sube aquí cuando cambia y la recupera al arrancar. La clave la crea
// la página al azar y se guarda en el iPhone; quien la tiene, tiene la copia (por eso no pide el token).
const DATOS = process.env.DATOS || path.join(here, 'datos');
function datos(req, res, key) {
  const file = path.join(DATOS, `${key}.tgz`);
  if (req.method === 'GET') {
    fs.stat(file, (err, st) => {
      if (err) { res.writeHead(404, isolation()).end(); return; }
      res.writeHead(200, isolation({ 'content-type': 'application/gzip', 'content-length': st.size, 'cache-control': 'no-store' }));
      fs.createReadStream(file).pipe(res);
    });
    return;
  }
  if (req.method !== 'PUT') { res.writeHead(405, isolation()).end(); return; }
  fs.mkdirSync(DATOS, { recursive: true });
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
  const dk = /^\/vm\/datos\/([A-Za-z0-9_-]{32,64})$/.exec(url.pathname);
  if (dk) return datos(req, res, dk[1]);
  const auth = authorized(req, url);
  if (!auth) {
    res.writeHead(401, isolation({ 'content-type': 'text/plain; charset=utf-8' })).end('Falta el token: abre el enlace completo que te dieron.');
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
  // Enlace de inicio de sesión de Claude: la página lo abre a través de aquí (una redirección del propio
  // servidor) para que iOS lo abra en Safari y no en la app de Claude, que no enseña el código a pegar.
  if (url.pathname === '/vm/ir') {
    const to = url.searchParams.get('u') || '';
    let ok = false;
    try { ok = /^(claude\.ai|claude\.com|platform\.claude\.com|console\.anthropic\.com)$/.test(new URL(to).hostname) && to.startsWith('https://'); } catch {}
    res.writeHead(ok ? 302 : 400, isolation(ok ? { location: to, 'cache-control': 'no-store' } : { 'content-type': 'text/plain; charset=utf-8' })).end(ok ? '' : 'Enlace no permitido');
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

// Relé: la página habla WebSocket con /net y nosotros lo pasamos tal cual a c2w-net.
// c2w-net solo lleva la red de un Linux: la tiene la pestaña que abrió la red la última. Cada página
// manda su id de sesión (?sid=); al llegar una nueva se corta la anterior, y esta ya no puede volver
// (lo comprueba en /vm/net-owner y lo dice en pantalla en vez de pelearse por la red).
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
      console.log(`red: la sesión ${sid || '(sin id)'} sustituye a ${netOwner.sid || '(sin id)'}`);
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
    // c2w-net rechaza (403) un WebSocket sin Origin; el token ya lo ha comprobado la puerta.
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
  console.log(`\n  Bolsillo en Safari → http://${HOST}:${PORT}/vm/?t=${TOKEN}\n`);
});
