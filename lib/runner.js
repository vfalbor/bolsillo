// Starts and stops user apps, each on its own port.
// A project declares how to run in bolsillo.json: { "start": "node server.js" }.
// Without "start" it is served as a static site by Bolsillo itself.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { serveStatic } from './static.js';

export class Runner {
  constructor({ basePort = 7701, host = '127.0.0.1' }) {
    this.basePort = basePort;
    this.host = host;
    this.running = new Map(); // id -> { port, proc?, server?, logs: [] }
  }

  status(id) {
    const r = this.running.get(id);
    return r ? { running: true, port: r.port, logs: r.logs.slice(-50) } : { running: false };
  }

  nextPort() {
    const used = new Set([...this.running.values()].map((r) => r.port));
    let p = this.basePort;
    while (used.has(p)) p++;
    return p;
  }

  async start(id, dir, config) {
    if (this.running.has(id)) return this.status(id);
    const port = this.nextPort();
    const entry = { port, logs: [] };
    const log = (line) => { entry.logs.push(line); if (entry.logs.length > 200) entry.logs.shift(); };

    if (config.start) {
      if (config.install && !fs.existsSync(path.join(dir, 'node_modules'))) {
        log(`$ ${config.install}`);
        await runOnce(config.install, dir, log);
      }
      log(`$ ${config.start}  (PORT=${port})`);
      entry.proc = spawn(config.start, {
        cwd: dir, shell: true, env: { ...process.env, PORT: String(port), HOST: this.host },
      });
      entry.proc.stdout.on('data', (d) => log(String(d).trimEnd()));
      entry.proc.stderr.on('data', (d) => log(String(d).trimEnd()));
      entry.proc.on('close', (code) => {
        log(`[the app exited with code ${code}]`);
        if (this.running.get(id) === entry) this.running.delete(id);
      });
    } else {
      const root = path.join(dir, config.static || '.');
      entry.server = http.createServer((req, res) => serveStatic(root, req, res));
      await new Promise((ok, fail) => entry.server.listen(port, this.host, ok).on('error', fail));
      log(`Serving ${config.static || '.'} as a static site`);
    }
    this.running.set(id, entry);
    return this.status(id);
  }

  stop(id) {
    const r = this.running.get(id);
    if (!r) return;
    this.running.delete(id);
    r.server?.close();
    if (r.proc) {
      r.proc.kill('SIGTERM');
      setTimeout(() => r.proc.exitCode === null && r.proc.kill('SIGKILL'), 3000).unref();
    }
  }

  stopAll() {
    for (const id of [...this.running.keys()]) this.stop(id);
  }
}

function runOnce(cmd, cwd, log) {
  return new Promise((resolve) => {
    const p = spawn(cmd, { cwd, shell: true });
    p.stdout.on('data', (d) => log(String(d).trimEnd()));
    p.stderr.on('data', (d) => log(String(d).trimEnd()));
    p.on('close', resolve);
  });
}
