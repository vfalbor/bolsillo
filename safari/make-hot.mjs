// Saca de una traza de QEMU nativo (-trace virtio_blk_handle_read) el orden en que el Linux lee los
// bloques de 4 MB de su disco al arrancar y abrir Claude, y lo deja en hot.json junto a pack.json: la
// página los va trayendo por adelantado (web/lazy-load.js).
//
//   node safari/make-hot.mjs <trace.log> [build/base/htdocs]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, process.argv[3] || 'build/base/htdocs');
const BLOCK = 4 << 20;
const pack = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
const order = [];
for (const m of fs.readFileSync(process.argv[2], 'utf8').matchAll(/sector (\d+) nsectors (\d+)/g)) {
  const from = Number(m[1]) * 512, to = from + Number(m[2]) * 512;
  for (let b = Math.floor(from / BLOCK); b * BLOCK < to; b++) if (!order.includes(b)) order.push(b);
}
fs.writeFileSync(path.join(dir, 'hot.json'), JSON.stringify({ data: pack.data, block: BLOCK, order }));
console.log(`hot.json: ${order.length} bloques (${order.length * 4} MB) en orden de lectura para ${pack.data}`);
