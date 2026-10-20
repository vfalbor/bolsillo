// Makes Claude Code's cli.js pure ASCII: every non-ASCII character becomes \uXXXX (those outside the
// basic plane, as a surrogate pair). In the browser's wasm emulator, Node and Bun fail to decode this
// file's UTF-8 (SyntaxError / Segmentation fault), and in ASCII there's nothing to decode. The original
// is kept as cli-utf8.js for the self-check.
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
if (/[^\x00-\x7f]/.test(res)) throw new Error('something non-ASCII is left');
fs.writeFileSync(out, res, { mode: 0o755 });
console.log(`${out}: ${s.length} → ${res.length} characters, all ASCII`);
