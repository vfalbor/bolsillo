import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Projects, slugify } from '../lib/projects.js';

const templatesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bolsillo-'));

test('slugify handles accents and symbols', () => {
  assert.equal(slugify('Cuentos de Ñoño & Lucía!'), 'cuentos-de-nono-lucia');
  assert.equal(slugify('!!!'), 'app');
});

test('templates are listed without the shared folder', () => {
  const ids = new Projects({ dataDir: tmp(), templatesDir }).listTemplates().map((t) => t.id);
  assert.ok(ids.includes('audiobooks'));
  assert.ok(!ids.includes('_shared'));
});

test('create copies template + shared rules and commits; undo reverts', () => {
  const projects = new Projects({ dataDir: tmp(), templatesDir });
  const a = projects.create({ name: 'Stories', template: 'audiobooks', idea: 'with dinosaurs' });
  const b = projects.create({ name: 'Stories', template: 'audiobooks' });
  assert.equal(a.id, 'stories');
  assert.equal(b.id, 'stories-2');
  assert.equal(a.idea, 'with dinosaurs');
  const dir = projects.dir(a.id);
  assert.ok(fs.existsSync(path.join(dir, 'CLAUDE.md')));
  assert.ok(fs.existsSync(path.join(dir, 'books.json')));

  fs.writeFileSync(path.join(dir, 'extra.txt'), 'x');
  assert.equal(projects.snapshot(a.id, 'add extra'), true);
  assert.equal(projects.snapshot(a.id, 'nothing'), false);
  assert.equal(projects.history(a.id)[0].message, 'add extra');
  projects.undo(a.id);
  assert.ok(!fs.existsSync(path.join(dir, 'extra.txt')));
  assert.throws(() => projects.undo(a.id), /no changes/);
});

test('state and chat are kept out of git', () => {
  const projects = new Projects({ dataDir: tmp(), templatesDir });
  const p = projects.create({ name: 'x' });
  projects.setState(p.id, { sessionId: 'abc' });
  projects.appendChat(p.id, { role: 'user', text: 'hello' });
  assert.equal(projects.get(p.id).sessionId, 'abc');
  assert.equal(projects.chat(p.id)[0].text, 'hello');
  assert.equal(projects.snapshot(p.id, 'should be empty'), false);
});

test('rejects path-like ids', () => {
  const projects = new Projects({ dataDir: tmp(), templatesDir });
  assert.throws(() => projects.dir('../etc'), /invalid/);
});
