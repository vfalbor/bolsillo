// Parchea el load.js que genera container2wasm (file_packager de Emscripten) para que la descarga del
// paquete de datos no ocupe el doble de memoria: el original guarda todos los trozos y al final los
// copia a un búfer nuevo (dos copias de ~660 MB a la vez); este reserva el búfer una vez, con el
// tamaño conocido, y copia cada trozo según llega. Idempotente; hay que pasarlo tras cada build.
//
//   node safari/patch-load.mjs [build/base/htdocs]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(path.resolve(here, process.argv[2] || 'build/base/htdocs'), 'load.js');
let s = fs.readFileSync(file, 'utf8');
const MARK = '/* bolsillo: búfer único */';
if (s.includes(MARK)) { console.log(`ya parcheado: ${file}`); process.exit(0); }

const replace = (from, to) => {
  if (!s.includes(from)) throw new Error(`no encuentro en ${file}:\n${from}`);
  s = s.replace(from, to);
};
replace('const chunks = [];', `${MARK} let packageData = new Uint8Array(packageSize);`);
replace(`                chunks.push(value);
                loaded += value.length;`, `                if (loaded + value.length > packageData.length) { // por si el tamaño anunciado se queda corto
                  const bigger = new Uint8Array(Math.max(loaded + value.length, packageData.length * 1.25));
                  bigger.set(packageData.subarray(0, loaded));
                  packageData = bigger;
                }
                packageData.set(value, loaded);
                loaded += value.length;`);
replace(`                const packageData = new Uint8Array(chunks.map((c) => c.length).reduce((a, b) => a + b, 0));
                let offset = 0;
                for (const chunk of chunks) {
                  packageData.set(chunk, offset);
                  offset += chunk.length;
                }
                callback(packageData.buffer);`, `                callback(loaded === packageData.length ? packageData.buffer : packageData.slice(0, loaded).buffer);`);
fs.writeFileSync(file, s);
console.log(`parcheado: ${file}`);
