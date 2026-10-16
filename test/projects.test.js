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
  assert.ok(ids.includes('audiolibros'));
  assert.ok(!ids.includes('_shared'));
});

test('create copies template + shared rules and commits; undo reverts', () => {
  const projects = new Projects({ dataDir: tmp(), templatesDir });
  const a = projects.create({ name: 'Cuentos', template: 'audiolibros', idea: 'con dinos' });
  const b = projects.create({ name: 'Cuentos', template: 'audiolibros' });
  assert.equal(a.id, 'cuentos');
  assert.equal(b.id, 'cuentos-2');
  assert.equal(a.idea, 'con dinos');
  const dir = projects.dir(a.id);
  assert.ok(fs.existsSync(path.join(dir, 'CLAUDE.md')));
  assert.ok(fs.existsSync(path.join(dir, 'libros.json')));

  fs.writeFileSync(path.join(dir, 'extra.txt'), 'x');
  assert.equal(projects.snapshot(a.id, 'añade extra'), true);
  assert.equal(projects.snapshot(a.id, 'nada'), false);
  assert.equal(projects.history(a.id)[0].message, 'añade extra');
  projects.undo(a.id);
  assert.ok(!fs.existsSync(path.join(dir, 'extra.txt')));
  assert.throws(() => projects.undo(a.id), /No hay cambios/);
});

test('state and chat are kept out of git', () => {
  const projects = new Projects({ dataDir: tmp(), templatesDir });
  const p = projects.create({ name: 'x' });
  projects.setState(p.id, { sessionId: 'abc' });
  projects.appendChat(p.id, { role: 'user', text: 'hola' });
  assert.equal(projects.get(p.id).sessionId, 'abc');
  assert.equal(projects.chat(p.id)[0].text, 'hola');
  assert.equal(projects.snapshot(p.id, 'should be empty'), false);
});

test('rejects path-like ids', () => {
  const projects = new Projects({ dataDir: tmp(), templatesDir });
  assert.throws(() => projects.dir('../etc'), /inválido/);
});
