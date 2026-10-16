// Projects live in <dataDir>/projects/<id>. Each one is a git repo created from a template.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const CONFIG_FILE = 'bolsillo.json';
const STATE_FILE = '.bolsillo-state.json'; // session id etc., not committed
const CHAT_FILE = '.bolsillo-chat.jsonl';

export function slugify(name) {
  const slug = name.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug || 'app';
}

export class Projects {
  constructor({ dataDir, templatesDir }) {
    this.root = path.join(dataDir, 'projects');
    this.templatesDir = templatesDir;
    fs.mkdirSync(this.root, { recursive: true });
  }

  dir(id) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error('id inválido');
    return path.join(this.root, id);
  }

  listTemplates() {
    return fs.readdirSync(this.templatesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .map((d) => ({ id: d.name, ...readJson(path.join(this.templatesDir, d.name, CONFIG_FILE)) }));
  }

  list() {
    return fs.readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(this.root, d.name, CONFIG_FILE)))
      .map((d) => this.get(d.name))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  get(id) {
    const dir = this.dir(id);
    if (!fs.existsSync(path.join(dir, CONFIG_FILE))) return null;
    return { id, ...readJson(path.join(dir, CONFIG_FILE)), ...readJson(path.join(dir, STATE_FILE)) };
  }

  create({ name, template = 'web-basica', idea = '' }) {
    const tplDir = path.join(this.templatesDir, template);
    if (!fs.existsSync(tplDir)) throw new Error(`No existe la plantilla ${template}`);
    let id = slugify(name);
    for (let n = 2; fs.existsSync(path.join(this.root, id)); n++) id = `${slugify(name)}-${n}`;
    const dir = path.join(this.root, id);
    fs.cpSync(tplDir, dir, { recursive: true });
    const shared = path.join(this.templatesDir, '_shared');
    if (fs.existsSync(shared)) fs.cpSync(shared, dir, { recursive: true, force: false });

    const cfg = readJson(path.join(dir, CONFIG_FILE));
    Object.assign(cfg, { name, template, idea, createdAt: Date.now() });
    writeJson(path.join(dir, CONFIG_FILE), cfg);
    fs.writeFileSync(path.join(dir, '.gitignore'), `${STATE_FILE}\n${CHAT_FILE}\nnode_modules/\n`);
    gitInit(dir, `Proyecto creado desde la plantilla "${template}"`);
    this.setState(id, { updatedAt: Date.now() });
    return this.get(id);
  }

  setState(id, patch) {
    const file = path.join(this.dir(id), STATE_FILE);
    writeJson(file, { ...readJson(file), ...patch });
  }

  // Commits whatever the agent changed so every turn can be undone.
  snapshot(id, message) {
    const dir = this.dir(id);
    try {
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', message.slice(0, 200));
      return true;
    } catch { return false; } // nothing to commit
  }

  undo(id) {
    const dir = this.dir(id);
    const count = Number(git(dir, 'rev-list', '--count', 'HEAD').trim());
    if (count < 2) throw new Error('No hay cambios que deshacer');
    git(dir, 'reset', '--hard', '-q', 'HEAD~1');
  }

  history(id) {
    const out = git(this.dir(id), 'log', '--pretty=format:%h%x09%ct%x09%s', '-n', '30');
    return out.split('\n').filter(Boolean).map((l) => {
      const [hash, ts, ...msg] = l.split('\t');
      return { hash, at: Number(ts) * 1000, message: msg.join('\t') };
    });
  }

  appendChat(id, entry) {
    fs.appendFileSync(path.join(this.dir(id), CHAT_FILE), JSON.stringify({ at: Date.now(), ...entry }) + '\n');
  }

  chat(id) {
    try {
      return fs.readFileSync(path.join(this.dir(id), CHAT_FILE), 'utf8')
        .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  }

  remove(id) {
    fs.rmSync(this.dir(id), { recursive: true, force: true });
  }
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'Bolsillo', GIT_AUTHOR_EMAIL: 'bolsillo@localhost',
      GIT_COMMITTER_NAME: 'Bolsillo', GIT_COMMITTER_EMAIL: 'bolsillo@localhost' },
  });
}

function gitInit(dir, message) {
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}
