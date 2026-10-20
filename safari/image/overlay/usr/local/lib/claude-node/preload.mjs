// Arranque de Claude Code sin token: carga cli.js ya (minutos en el emulador del navegador) y el token llega
// después en un fichero (BOLSILLO_TOKEN_FILE, una línea), que se pasa a la variable de entorno que Claude lee
// en cada comprobación. Así Claude puede estar cargado antes de que la persona inicie sesión.
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
