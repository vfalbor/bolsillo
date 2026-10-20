// Starts Claude Code without a token: loads cli.js right away (minutes in the browser's emulator) and the
// token arrives later in a file (BOLSILLO_TOKEN_FILE, one line), which is copied into the environment
// variable Claude reads on every check. That way Claude can be loaded before the person signs in.
import fs from 'node:fs';

const file = process.env.BOLSILLO_TOKEN_FILE || '/run/bolsillo/token';
const timer = setInterval(() => {
  let token = '';
  try { token = fs.readFileSync(file, 'utf8').trim(); } catch { return; }
  if (!token) return;
  try { fs.unlinkSync(file); } catch {}
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN; delete process.env.ANTHROPIC_API_KEY;
  if (token.startsWith('sk-ant-oat')) process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
  else if (token.startsWith('sk-ant-')) process.env.ANTHROPIC_API_KEY = token;
}, 500);
timer.unref();

await import('./cli.js');
