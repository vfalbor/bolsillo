// Publica una instantánea hecha con make-snapshot.py junto al disco con el que se hizo: la copia como
// <nombre>.data (gateway.js solo sirve comprimidos los .data) y escribe snap.json, que lee web/lazy-load.js.
// Después hay que pasar warm-z.mjs.
//
//   node safari/publish-snapshot.mjs <vm.state> <nombre, p. ej. bolsillo-snap-v11> <mem MB> <cpus> [build/base/htdocs]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [src, name, mem, smp, htdocs = path.join(here, 'build/base/htdocs')] = process.argv.slice(2);
const pack = JSON.parse(fs.readFileSync(path.join(htdocs, 'pack.json'), 'utf8'));
const file = `${name}.data`;
fs.copyFileSync(src, path.join(htdocs, file));
// CRC32 de cada trozo de 1 MB, como el disco en pack.json: lazy-load.js comprueba lo que llega.
const CHUNK = 1 << 20, size = fs.statSync(src).size, crc = [];
const fd = fs.openSync(src, 'r'), buf = Buffer.alloc(CHUNK);
for (let p = 0; p < size; p += CHUNK) crc.push(zlib.crc32(buf.subarray(0, fs.readSync(fd, buf, 0, CHUNK, p))));
fs.closeSync(fd);
const snap = { file, size, mem: Number(mem), smp: Number(smp), disk: pack.data, crc };
fs.writeFileSync(path.join(htdocs, 'snap.json'), JSON.stringify(snap));
console.log(`snap.json: ${file} (${Math.round(size / 1048576)} MB, ${mem} MB de RAM, ${smp} CPU) para el disco ${pack.data}`);
