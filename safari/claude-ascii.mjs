// Deja el cli.js de Claude Code solo en ASCII: cada carácter no ASCII pasa a \uXXXX (los de fuera del
// plano básico, como par de sustitutos). En el emulador wasm del navegador, Node y Bun fallan al
// descodificar el UTF-8 de este fichero (SyntaxError / Segmentation fault) y en ASCII no hay nada que
// descodificar. El original se guarda como cli-utf8.js para el autodiagnóstico.
//
//   node safari/claude-ascii.mjs safari/image/overlay/usr/local/lib/claude-node
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const orig = path.join(dir, 'cli-utf8.js'), out = path.join(dir, 'cli.js');
if (!fs.existsSync(orig)) fs.renameSync(out, orig);
const s = fs.readFileSync(orig, 'utf8');
let res = '', last = 0;
for (let i = 0; i < s.length; i++) {
  const c = s.charCodeAt(i);
  if (c > 127) { res += s.slice(last, i) + '\\u' + c.toString(16).padStart(4, '0'); last = i + 1; }
}
res += s.slice(last);
if (/[^\x00-\x7f]/.test(res)) throw new Error('queda algo no ASCII');
fs.writeFileSync(out, res, { mode: 0o755 });
console.log(`${out}: ${s.length} → ${res.length} caracteres, todo ASCII`);
