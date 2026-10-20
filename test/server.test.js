import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let app; let base;

before(async () => {
  app = createApp({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bolsillo-srv-')),
    claudeBin: path.join(here, 'fixtures', 'fake-claude.js'),
    basePort: 17801,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.close());

const call = async (p, method = 'GET', body) => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
};

async function chat(id, message) {
  const res = await fetch(`${base}/api/projects/${id}/chat`, { method: 'POST', body: JSON.stringify({ message }) });
  const text = await res.text();
  return text.split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')));
}

test('serves the UI', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Bolsillo/);
});

test('info reports the claude version', async () => {
  const { data } = await call('/api/info');
  assert.match(data.claude, /9\.9\.9/);
});

test('full flow: create, chat twice (resumes session), undo, run, stop, delete', async () => {
  const { data: p } = await call('/api/projects', 'POST', { name: 'My Stories', template: 'audiobooks' });
  assert.equal(p.id, 'my-stories');

  const evs = await chat(p.id, 'pon dinosaurios');
  assert.deepEqual(evs.map((e) => e.type), ['session', 'tool', 'text', 'done']);
  assert.equal(evs.at(-1).changed, true);

  const evs2 = await chat(p.id, 'y cohetes');
  assert.match(evs2.find((e) => e.type === 'text').text, /reanudado/);

  let { data: detail } = await call(`/api/projects/${p.id}`);
  assert.equal(detail.sessionId, 'sess-123');
  assert.equal(detail.chat.length, 4);
  assert.equal(detail.history[0].message, 'y cohetes');

  await call(`/api/projects/${p.id}/undo`, 'POST');
  ({ data: detail } = await call(`/api/projects/${p.id}`));
  assert.equal(detail.history[0].message, 'pon dinosaurios');

  const { data: run } = await call(`/api/projects/${p.id}/run`, 'POST');
  assert.equal(run.running, true);
  const page = await fetch(`http://127.0.0.1:${run.port}/`);
  assert.match(await page.text(), /My stories/);
  assert.equal((await fetch(`http://127.0.0.1:${run.port}/.git/config`)).status, 404);

  await call(`/api/projects/${p.id}/stop`, 'POST');
  ({ data: detail } = await call(`/api/projects/${p.id}`));
  assert.equal(detail.running, false);

  await call(`/api/projects/${p.id}`, 'DELETE');
  assert.equal((await call(`/api/projects/${p.id}`)).status, 404);
});

test('validation errors', async () => {
  assert.equal((await call('/api/projects', 'POST', { name: '' })).status, 400);
  assert.equal((await call('/api/projects', 'POST', { name: 'x', template: 'nope' })).status, 500);
  assert.equal((await call('/api/device/nope', 'POST', {})).status, 404);
});

test('token is required when listening beyond localhost', async () => {
  const lan = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'b-')), host: '0.0.0.0', token: 'secreto' });
  await new Promise((r) => lan.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${lan.server.address().port}`;
  assert.equal((await fetch(url + '/api/projects')).status, 401);
  assert.equal((await fetch(url + '/api/projects?token=secreto')).status, 200);
  assert.equal((await fetch(url + '/api/projects', { headers: { cookie: 'bolsillo=secreto' } })).status, 200);
  lan.close();
});

test('claude sign-in: paste-the-code flow and saved keys', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'b-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    let { data: s } = await call('/api/claude');
    assert.deepEqual([s.installed, s.loggedIn], [true, false]);

    let { data: l } = await call('/api/claude/login', 'POST');
    for (let i = 0; !l.url && i < 50; i++) { await new Promise((r) => setTimeout(r, 100)); ({ data: l } = await call('/api/claude/login')); }
    assert.equal(l.url, 'https://claude.com/cai/oauth/authorize?code=true&state=abc');

    await call('/api/claude/login/code', 'POST', { code: 'codigo-bueno' });
    for (let i = 0; l.state !== 'done' && i < 50; i++) { await new Promise((r) => setTimeout(r, 100)); ({ data: l } = await call('/api/claude/login')); }
    assert.equal(l.state, 'done');
    ({ data: s } = await call('/api/claude'));
    assert.equal(s.loggedIn, true);

    assert.equal((await call('/api/claude/key', 'POST', { key: 'hello' })).status, 400);
    ({ data: s } = await call('/api/claude/key', 'POST', { key: 'sk-ant-oat01-abcdefghijkl' }));
    assert.deepEqual(app.account.env(), { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-abcdefghijkl' });
    await call('/api/claude/key', 'DELETE');
    assert.deepEqual(app.account.env(), {});
  } finally {
    process.env.HOME = prevHome;
  }
});

test('linux console and launch links', async () => {
  const { data: out } = await call('/api/shell', 'POST', { cmd: 'echo hello && exit 3' });
  assert.deepEqual(out, { code: 3, output: 'hello\n' });

  const { data: p } = await call('/api/projects', 'POST', { name: 'Lanzable', template: 'basic-web' });
  const res = await fetch(`${base}/launch/${p.id}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const target = res.headers.get('location');
  assert.match(target, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal((await fetch(target)).status, 200);
  await call(`/api/projects/${p.id}`, 'DELETE');
});

test('device calls go to the Android bridge when present', async () => {
  const seen = [];
  const bridge = (await import('node:http')).createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: body && JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/caps' ? { caps: ['speak', 'shortcut'] } : { ok: true }));
    });
  });
  await new Promise((r) => bridge.listen(0, '127.0.0.1', r));
  process.env.BOLSILLO_BRIDGE = `http://127.0.0.1:${bridge.address().port}`;
  process.env.BOLSILLO_BRIDGE_TOKEN = 't0k';
  try {
    const { data: caps } = await call('/api/device');
    assert.equal(caps.find((c) => c.name === 'speak').available, true);
    assert.equal(caps.find((c) => c.name === 'torch').available, false);
    const { data } = await call('/api/device/speak', 'POST', { text: 'hello' });
    assert.deepEqual(data, { ok: true });
    assert.deepEqual(seen.at(-1), { url: '/speak', auth: 'Bearer t0k', body: { text: 'hello' } });
    assert.equal((await call('/api/info')).data.android, true);
  } finally {
    delete process.env.BOLSILLO_BRIDGE;
    delete process.env.BOLSILLO_BRIDGE_TOKEN;
    bridge.close();
  }
});
