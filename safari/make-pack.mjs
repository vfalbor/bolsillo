// Saca del load.js que genera container2wasm la tabla de ficheros del paquete .data (nombre, inicio, fin)
// y la deja en pack.json, que es lo que lee web/lazy-load.js para descargar cada fichero por separado.
// Hay que pasarlo tras cada build.
//
//   node safari/make-pack.mjs [build/base/htdocs] [nombre del .data, si se renombró]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, process.argv[2] || 'build/base/htdocs');
const src = fs.readFileSync(path.join(dir, 'load.js'), 'utf8');
const m = /loadPackage\((\{"files".*?"remote_package_size":\s*\d+\})\)/s.exec(src);
if (!m) throw new Error(`no encuentro loadPackage({...}) en ${dir}/load.js`);
const meta = JSON.parse(m[1]);
const data = process.argv[3] || /REMOTE_PACKAGE_BASE = '([^']+)'/.exec(src)?.[1] || 'qemu-system-aarch64.data';
const size = fs.statSync(path.join(dir, data)).size;
if (size !== meta.remote_package_size) throw new Error(`${data} mide ${size} y load.js dice ${meta.remote_package_size}`);
const pack = { data, size, files: meta.files.map(({ filename, start, end }) => ({ name: filename, start, end })) };
// CRC32 de cada trozo de 1 MB del disco: lazy-load.js comprueba lo que llega y lo vuelve a pedir si no cuadra.
const CHUNK = 1 << 20;
const disk = pack.files.find((f) => f.name === '/pack/rootfs.bin');
if (disk) {
  const fd = fs.openSync(path.join(dir, data), 'r'), buf = Buffer.alloc(CHUNK);
  disk.chunk = CHUNK;
  disk.crc = [];
  for (let p = disk.start; p < disk.end; p += CHUNK) {
    const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, disk.end - p), p);
    disk.crc.push(zlib.crc32(buf.subarray(0, n)));
  }
  fs.closeSync(fd);
}
fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(pack, null, 1));
for (const f of pack.files) console.log(`${((f.end - f.start) / 1048576).toFixed(1).padStart(7)} MB  ${f.name}`);
console.log(`pack.json → ${dir}`);
