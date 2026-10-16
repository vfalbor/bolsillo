// Runs Claude Code headless inside a project folder and turns its
// stream-json output into simple events the mobile UI can show.
import { spawn } from 'node:child_process';
import readline from 'node:readline';

// Tools the agent may use without asking. Bash is limited to common dev commands.
export const SAFE_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite', 'WebFetch', 'WebSearch',
  'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(python3:*)', 'Bash(pip:*)',
  'Bash(git:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(mkdir:*)', 'Bash(cp:*)', 'Bash(mv:*)',
  'Bash(curl:*)', 'Bash(termux-:*)', 'Bash(apk:*)',
];

const TOOL_LABELS = {
  Write: (i) => `Creando ${short(i.file_path)}`,
  Edit: (i) => `Modificando ${short(i.file_path)}`,
  Read: (i) => `Leyendo ${short(i.file_path)}`,
  Bash: (i) => `Ejecutando: ${i.command?.slice(0, 80)}`,
  Glob: () => 'Buscando ficheros',
  Grep: () => 'Buscando en el código',
  WebSearch: (i) => `Buscando en internet: ${i.query}`,
  WebFetch: (i) => `Leyendo ${i.url}`,
  TodoWrite: () => 'Organizando tareas',
};

function short(p = '') {
  return p.split('/').slice(-2).join('/');
}

// Maps one parsed stream-json object to zero or more UI events.
export function toEvents(msg) {
  if (!msg || typeof msg !== 'object') return [];
  if (msg.type === 'system' && msg.subtype === 'init') {
    return [{ type: 'session', sessionId: msg.session_id }];
  }
  if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
    return msg.message.content.flatMap((block) => {
      if (block.type === 'text' && block.text?.trim()) return [{ type: 'text', text: block.text }];
      if (block.type === 'tool_use') {
        const label = TOOL_LABELS[block.name]?.(block.input || {}) ?? `Usando ${block.name}`;
        return [{ type: 'tool', name: block.name, label }];
      }
      return [];
    });
  }
  if (msg.type === 'result') {
    return [{
      type: 'done',
      ok: !msg.is_error,
      sessionId: msg.session_id,
      costUsd: msg.total_cost_usd,
      error: msg.is_error ? (msg.result || msg.subtype) : undefined,
    }];
  }
  return [];
}

// If Bolsillo itself was launched from inside a Claude Code session, don't let the child
// think it is a sub-session of it. Auth/config variables are kept.
const KEEP = new Set(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']);
export function cleanEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) =>
    KEEP.has(k) || !(k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT' || k.startsWith('CLAUDE_CODE_'))));
}

// Starts a turn. onEvent receives UI events; returns { child, done: Promise }.
export function runTurn({ cwd, prompt, sessionId, freeMode = false, claudeBin = 'claude', env = {}, onEvent }) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
  if (sessionId) args.push('--resume', sessionId);
  if (freeMode) args.push('--permission-mode', 'bypassPermissions');
  else args.push('--permission-mode', 'acceptEdits', '--allowedTools', SAFE_TOOLS.join(','));

  const child = spawn(claudeBin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...cleanEnv(process.env), ...env } });
  let stderr = '';
  let finished = false;
  child.stderr.on('data', (d) => { stderr += d; });

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    for (const ev of toEvents(msg)) {
      if (ev.type === 'done') finished = true;
      onEvent(ev);
    }
  });

  const done = new Promise((resolve) => {
    child.on('error', (err) => {
      onEvent({ type: 'done', ok: false, error: `No se pudo lanzar Claude Code (${err.message}). ¿Está instalado y has iniciado sesión?` });
      finished = true;
      resolve();
    });
    child.on('close', (code) => {
      if (!finished) onEvent({ type: 'done', ok: code === 0, error: code ? stderr.slice(-500) || `salida ${code}` : undefined });
      resolve();
    });
  });
  return { child, done };
}
