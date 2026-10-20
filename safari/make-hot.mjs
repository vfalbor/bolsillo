// Extracts from a native QEMU trace (-trace virtio_blk_handle_read) the order in which Linux reads the
// 4 MB blocks of its disk while booting and opening Claude, and writes it to hot.json next to pack.json:
// the page prefetches them (web/lazy-load.js).
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
console.log(`hot.json: ${order.length} blocks (${order.length * 4} MB) in read order for ${pack.data}`);
