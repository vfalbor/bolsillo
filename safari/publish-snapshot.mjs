// Publishes a snapshot made with make-snapshot.py next to the disk it was made with: copies it as
// <name>.data (gateway.js only serves .data files compressed) and writes snap.json, which web/lazy-load.js
// reads. Then run warm-z.mjs.
//
//   node safari/publish-snapshot.mjs <vm.state> <name, e.g. bolsillo-snap-v12> <mem MB> <cpus> [build/base/htdocs]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [src, name, mem, smp, htdocs = path.join(here, 'build/base/htdocs')] = process.argv.slice(2);
const pack = JSON.parse(fs.readFileSync(path.join(htdocs, 'pack.json'), 'utf8'));
const file = `${name}.data`;
fs.copyFileSync(src, path.join(htdocs, file));
// CRC32 of every 1 MB chunk, like the disk in pack.json: lazy-load.js checks what arrives.
const CHUNK = 1 << 20, size = fs.statSync(src).size, crc = [];
const fd = fs.openSync(src, 'r'), buf = Buffer.alloc(CHUNK);
for (let p = 0; p < size; p += CHUNK) crc.push(zlib.crc32(buf.subarray(0, fs.readSync(fd, buf, 0, CHUNK, p))));
fs.closeSync(fd);
const snap = { file, size, mem: Number(mem), smp: Number(smp), disk: pack.data, crc };
fs.writeFileSync(path.join(htdocs, 'snap.json'), JSON.stringify(snap));
console.log(`snap.json: ${file} (${Math.round(size / 1048576)} MB, ${mem} MB of RAM, ${smp} CPU) for disk ${pack.data}`);
