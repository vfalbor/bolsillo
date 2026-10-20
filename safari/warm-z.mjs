// Precompresses what web/lazy-load.js requests (aligned 4 MB disk blocks and the other files whole), in
// brotli and gzip, into the cache gateway.js uses (/vm/z/). That way the first visit doesn't wait for
// compression. Run it after every make-pack.mjs (with a new .data).
//
//   node safari/warm-z.mjs [build/base/htdocs]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, process.argv[2] || 'build/base/htdocs');
const ZCACHE = process.env.ZCACHE || path.join(here, 'build', 'zcache');
const BLOCK = 4 << 20; // same as BLOCK × CHUNK in lazy-load.js
const pack = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
const snapFile = path.join(dir, 'snap.json');
const snap = fs.existsSync(snapFile) ? JSON.parse(fs.readFileSync(snapFile, 'utf8')) : null;
const t0 = Date.now();
function warm(data, ranges, what) {
  const out = path.join(ZCACHE, data);
  fs.mkdirSync(out, { recursive: true });
  const fd = fs.openSync(path.join(dir, data), 'r');
  let raw = 0, br = 0, made = 0;
  for (const [s, e] of ranges) {
    const b = Buffer.alloc(e - s);
    fs.readSync(fd, b, 0, b.length, s);
    for (const [enc, f] of [
      ['br', () => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length } })],
      ['gzip', () => zlib.gzipSync(b, { level: 9 })],
    ]) {
      const file = path.join(out, `${s}-${e}.${enc}`);
      if (!fs.existsSync(file)) { fs.writeFileSync(file, f()); made++; }
      if (enc === 'br') br += fs.statSync(file).size;
    }
    raw += b.length;
  }
  fs.closeSync(fd);
  console.log(`${data}: ${made} new files · ${what} ${raw >> 20} MB → brotli ${br >> 20} MB (${Math.round(100 * br / raw)} %) · ${Math.round((Date.now() - t0) / 1000)} s`);
}
const blocks = (start, end) => { const r = []; for (let s = start; s < end; s += BLOCK) r.push([s, Math.min(end, s + BLOCK)]); return r; };
// The disk blocks and, whole, the other files (kernel, firmware); the snapshot, in blocks.
const disk = pack.files.find((f) => f.name.endsWith('rootfs.bin'));
warm(pack.data, [...blocks(disk.start, disk.end), ...pack.files.filter((f) => f !== disk && !f.name.endsWith('vm.state')).map((f) => [f.start, f.end])], 'disk');
if (snap) warm(snap.file, blocks(0, snap.size), 'snapshot');
// Old disk versions are no longer requested: drop their cache.
for (const old of fs.readdirSync(ZCACHE)) if (old !== pack.data && old !== snap?.file && !fs.existsSync(path.join(dir, old))) fs.rmSync(path.join(ZCACHE, old), { recursive: true });

