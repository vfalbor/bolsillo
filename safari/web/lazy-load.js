// Cargador de Bolsillo: sustituye al load.js que genera container2wasm (file_packager de Emscripten).
//
// El original descarga el paquete .data entero (660 MB) a la memoria de la pestaña antes de arrancar,
// y un iPhone mata la pestaña mucho antes. Este:
//   - descarga solo los ficheros pequeños que QEMU lee enteros (kernel, firmware, instantánea),
//     cada uno con una petición Range sobre el mismo .data;
//   - sirve el disco del Linux (rootfs.bin, ~470 MB) por trozos de 1 MB bajo demanda: solo se baja lo
//     que el Linux lee, y en memoria se guardan como mucho CACHE_MB (los más recientes). Lo que el Linux
//     escriba en el disco se queda en memoria (copia al escribir) y nunca se descarta.
//
// QEMU corre en un pthread y Emscripten pasa sus llamadas al sistema de ficheros al hilo principal, que
// espera la respuesta: por eso aquí la descarga de un trozo es una XHR síncrona (en el hilo principal
// no se puede pedir arraybuffer síncrono, así que va como texto x-user-defined).
//
// Opciones por URL (para medir en el iPhone):
//   ?mem=512     RAM del Linux en MB (768 por defecto). Con la RAM de la instantánea (snap.json) se arranca
//                desde ella: Linux y Claude ya cargados (ver make-snapshot.py).
//   ?snap=0      arranque en frío aunque haya instantánea.
//   ?cache=48    MB de disco que se guardan en memoria (96 por defecto).
//   ?ahead=0     sin lectura por adelantado (6 bloques de 4 MB por defecto).
//   ?z=0         disco sin comprimir.
//   ?bios=0      sin firmware UEFI: QEMU carga el kernel directamente (−64 MB de flash; solo en frío).
//   ?tb=64       MB del búfer de traducción del JIT de QEMU (256 por defecto).
//   ?smp=2       CPUs emuladas (1 por defecto; cada una es un hilo de QEMU, solo en frío).
(() => {
  const params = new URLSearchParams(location.search);
  const CHUNK = 1 << 20;
  const BLOCK = 4; // trozos por petición (bloques alineados de 4 MB)
  const CACHE_MB = Math.max(8, Number(params.get('cache')) || 96); // con 96 el arranque casi no espera a la red
  // 768 MB por defecto: con 1024 Safari cierra la pestaña en el iPhone.
  const memMB = Number(params.get('mem')) || 768;
  const noBios = params.get('bios') === '0';
  // Instantánea con Linux y Claude ya cargados (make-snapshot.py). snap.json dice el fichero, el disco con el
  // que se hizo y su RAM y CPUs; se lee aquí (síncrono, es pequeño) porque los argumentos de QEMU dependen de ella.
  // (La instantánea que trae container2wasm, de 1024 MB y sin nada cargado, ya no se usa.)
  const snap = (() => {
    // La instantánea está hecha en el modo chat: la interfaz de terminal (?modo=tui) arranca en frío.
    if (params.get('snap') === '0' || params.get('modo') === 'tui' || noBios) return null;
    try {
      const x = new XMLHttpRequest();
      x.open('GET', `snap.json?${Date.now()}`, false); x.send(null);
      const j = x.status === 200 ? JSON.parse(x.responseText) : null;
      return j && j.mem === memMB ? j : null;
    } catch { return null; }
  })();
  const useSnapshot = !!snap;
  const tbMB = Number(params.get('tb')) || 256; // 500 en los argumentos de container2wasm
  const smp = useSnapshot ? snap.smp : Math.min(4, Number(params.get('smp')) || 0);
  const LAZY = '/pack/rootfs.bin';

  const stats = window.bolsilloDisk = { compressed: params.get('z') !== '0', prefetchHits: 0, prefetchMB: 0, aheadMB: 0, order: [], snapMB: 0, snapSizeMB: useSnapshot ? Math.round(snap.size / 1048576) : 0, requests: 0, fetchedMB: 0, cachedMB: 0, dirtyMB: 0, waitMs: 0, badChunks: 0, badList: [], memMB, useSnapshot, noBios, tbMB, smp };

  // CRC32 (el mismo que zlib.crc32 en make-pack.mjs) para comprobar cada trozo del disco que llega.
  const CRC_TABLE = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const Module = (globalThis.Module ??= {});

  // Argumentos de QEMU según las opciones: se llama desde la página antes de arrancar el módulo.
  globalThis.bolsilloArgs = (args) => {
    args = [...args];
    if (!useSnapshot) {
      const i = args.indexOf('-incoming');
      if (i !== -1) args.splice(i, 2);
    }
    const m = args.indexOf('-m');
    if (m !== -1) args[m + 1] = `${memMB}M`;
    if (noBios) {
      const b = args.indexOf('-bios');
      if (b !== -1) args.splice(b, 2);
    }
    if (smp) {
      const c = args.indexOf('-smp');
      if (c !== -1) args[c + 1] = args[c + 1].replace(/^\d+/, String(smp));
    }
    if (tbMB) {
      const a = args.indexOf('-accel');
      if (a !== -1) args[a + 1] = args[a + 1].replace(/tb-size=\d+/, `tb-size=${tbMB}`);
    }
    return args;
  };

  const packP = fetch('pack.json', { cache: 'no-store' }).then((r) => {
    if (!r.ok) throw new Error(`pack.json: ${r.status}`);
    return r.json();
  });

  // Los trozos se piden comprimidos a /vm/z/ (≈1/3 del tamaño, y el navegador los guarda entre visitas);
  // si esa ruta falla se vuelve a la petición por partes normal. ?z=0 la desactiva.
  let useZ = params.get('z') !== '0';

  async function fetchRange(url, start, end) { // [start, end)
    // Primero comprimido (el firmware UEFI son 64 MB casi todo ceros: baja a unos pocos KB).
    if (useZ) {
      try {
        const r = await fetch(`z/${url}?s=${start}&e=${end}`);
        const buf = r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
        if (buf?.length === end - start) return buf;
      } catch {}
    }
    const r = await fetch(url, { headers: { range: `bytes=${start}-${end - 1}` } });
    if (r.status !== 206) throw new Error(`${url}: el servidor no admite descargas por partes (${r.status})`);
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length !== end - start) throw new Error(`${url}: llegaron ${buf.length} bytes de ${end - start}`);
    return buf;
  }

  function syncRange(url, start, end) { // [start, end), bloqueante
    const t = performance.now();
    const z = useZ && !url.includes('?');
    const xhr = new XMLHttpRequest();
    xhr.open('GET', z ? `z/${url}?s=${start}&e=${end}` : url, false);
    if (!z) xhr.setRequestHeader('Range', `bytes=${start}-${end - 1}`);
    xhr.overrideMimeType('text/plain; charset=x-user-defined');
    xhr.send(null);
    if (z && (xhr.status !== 200 || xhr.responseText.length !== end - start)) {
      useZ = false; stats.compressed = false;
      console.warn(`[bolsillo] disco comprimido no disponible (${xhr.status}), se piden los trozos sin comprimir`);
      return syncRange(url, start, end);
    }
    if (!z && xhr.status !== 206) throw new Error(`${url}: ${xhr.status} al pedir un trozo del disco`);
    const s = xhr.responseText;
    if (s.length !== end - start) throw new Error(`${url}: llegaron ${s.length} bytes de ${end - start}`);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    stats.requests++;
    stats.fetchedMB = Math.round((stats.fetchedMB * 1048576 + out.length) / 104857.6) / 10;
    stats.waitMs += Math.round(performance.now() - t);
    return out;
  }

  // Disco bajo demanda dentro del sistema de ficheros de Emscripten (MEMFS).
  // Fichero bajo demanda: el disco (orden de lectura de hot.json) o la instantánea (seq: QEMU la lee de
  // principio a fin una sola vez, así que se trae por delante en orden y se olvida lo ya leído).
  function lazyDisk(FS, url, base, size, crc, name = 'rootfs.bin', seq = false) {
    const CACHE = seq ? 8 : CACHE_MB;
    const cache = new Map(); // índice de trozo → bytes, en orden de uso (el primero es el más antiguo)
    const dirty = new Map(); // trozos escritos por el Linux: no se descartan
    const nChunks = Math.ceil(size / CHUNK);
    const chunkLen = (i) => Math.min(CHUNK, size - i * CHUNK);
    const touch = (i, c) => { cache.delete(i); cache.set(i, c); };
    const evict = () => {
      while (cache.size * CHUNK > CACHE * 1048576) cache.delete(cache.keys().next().value);
      if (!seq) stats.cachedMB = cache.size;
    };
    // Se pide siempre el bloque alineado de BLOCK trozos que contiene el que falta: así cada bloque tiene
    // siempre la misma URL (comprimido de antemano en el servidor y guardado por el navegador entre visitas).
    // Lectura por adelantado: hot.json dice en qué orden lee los bloques un arranque normal (hasta que Claude
    // abre). Mientras el Linux trabaja, se traen (sin bloquear) los siguientes de esa lista; cuando el Linux
    // los pide ya están aquí. Como mucho AHEAD bloques esperando, y se olvidan los que el Linux ya dejó atrás.
    const ahead = new Map(); // bloque → bytes
    const AHEAD = seq ? 8 : Math.max(0, Number(params.get('ahead') ?? 6));
    const prefetch = { order: [], pos: 0, inflight: 0, failed: 0, seen() {} };
    const nBlocks = Math.ceil(nChunks / BLOCK);
    const orderP = seq ? Promise.resolve({ data: url, block: BLOCK * CHUNK, order: [...Array(nBlocks).keys()] })
      : fetch('hot.json', { cache: 'no-store' }).then((r) => r.ok ? r.json() : null);
    if (AHEAD) orderP.then((hot) => {
      if (!hot || hot.data !== url || hot.block !== BLOCK * CHUNK) return;
      const where = new Map(hot.order.map((b, k) => [b, k]));
      Object.assign(prefetch, {
        order: hot.order,
        seen(b) { const k = where.get(b); if (k !== undefined && k >= this.pos) this.pos = k + 1; this.pump(); },
        pump() {
          for (const [b] of ahead) if ((where.get(b) ?? -1) < this.pos - 8) ahead.delete(b);
          for (let k = this.pos; k < this.order.length && this.inflight < (seq ? 3 : 2) && ahead.size + this.inflight < AHEAD && this.failed < 5; k++) {
            const b = this.order[k], s = b * BLOCK;
            if (ahead.has(b) || cache.has(s) || dirty.has(s) || this.pending.has(b)) continue;
            this.inflight++; this.pending.add(b);
            const e = Math.min(nChunks, s + BLOCK);
            fetch(`z/${url}?s=${base + s * CHUNK}&e=${base + Math.min(size, e * CHUNK)}`)
              .then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
              .then((buf) => { if (!cache.has(s)) { ahead.set(b, new Uint8Array(buf)); if (!seq) stats.prefetchMB += buf.byteLength / 1048576; } })
              .catch(() => { this.failed++; })
              .finally(() => { this.inflight--; this.pending.delete(b); this.pump(); });
          }
          if (!seq) stats.aheadMB = ahead.size * BLOCK;
        },
        pending: new Set(),
      });
      prefetch.pump();
    }).catch(() => {});

    const load = (first, last) => {
      for (let i = first; i <= last; i++) {
        if (dirty.has(i) || cache.has(i)) continue;
        const s = i - (i % BLOCK), e = Math.min(nChunks, s + BLOCK), b = s / BLOCK;
        let bytes = ahead.get(b);
        if (bytes) { ahead.delete(b); if (!seq) stats.prefetchHits++; } else bytes = syncRange(url, base + s * CHUNK, base + Math.min(size, e * CHUNK));
        if (seq) stats.snapMB = Math.round(Math.min(size, e * CHUNK) / 1048576);
        else if (stats.order.length < 400) stats.order.push(b);
        prefetch.seen(b);
        for (let k = s; k < e; k++) if (!dirty.has(k)) touch(k, verified(k, bytes.subarray((k - s) * CHUNK, (k - s) * CHUNK + chunkLen(k))));
        i = e - 1;
      }
      evict();
    };
    // Un trozo que no cuadra con su CRC (caché del navegador o red) se vuelve a pedir saltándose la caché;
    // si sigue mal, error de lectura: mejor que el Linux ejecute datos corruptos.
    const verified = (k, b) => {
      if (!crc || crc32(b) === crc[k]) return b;
      stats.badChunks++;
      if (stats.badList.length < 20) stats.badList.push(k);
      console.warn(`[bolsillo] disco: el trozo ${k} llegó mal, se vuelve a pedir`);
      const again = syncRange(`${url}?r=${Date.now()}`, base + k * CHUNK, base + k * CHUNK + chunkLen(k));
      if (crc32(again) === crc[k]) return again;
      throw new Error(`el trozo ${k} del disco llega corrupto`);
    };
    const get = (i) => {
      const d = dirty.get(i);
      if (d) return d;
      let c = cache.get(i);
      if (!c) { load(i, i); c = cache.get(i); }
      touch(i, c);
      return c;
    };

    const node = FS.createFile('/pack', name, {}, true, true);
    node.contents = { length: size }; // para que Emscripten no intente cargarlo por su cuenta
    Object.defineProperty(node, 'usedBytes', { get: () => size, set() {} });
    const ops = { ...node.stream_ops };
    ops.read = (stream, buffer, offset, length, position) => {
      if (position >= size) return 0;
      const end = Math.min(size, position + length);
      try { load(Math.floor(position / CHUNK), Math.floor((end - 1) / CHUNK)); } catch (e) { console.error(`[bolsillo] ${name}:`, e.message); throw new FS.ErrnoError(29); }
      const heap = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
      for (let p = position, o = offset; p < end;) {
        const i = Math.floor(p / CHUNK), s = p - i * CHUNK, c = get(i), n = Math.min(c.length - s, end - p);
        heap.set(c.subarray(s, s + n), o);
        p += n; o += n;
      }
      return end - position;
    };
    ops.write = (stream, buffer, offset, length, position) => {
      const end = Math.min(size, position + length);
      const heap = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
      for (let p = position, o = offset; p < end;) {
        const i = Math.floor(p / CHUNK), s = p - i * CHUNK;
        let d = dirty.get(i);
        if (!d) { d = new Uint8Array(get(i)); dirty.set(i, d); cache.delete(i); stats.dirtyMB = dirty.size; }
        const n = Math.min(d.length - s, end - p);
        d.set(heap.subarray(o, o + n), s);
        p += n; o += n;
      }
      return end - position;
    };
    ops.mmap = () => { throw new FS.ErrnoError(43); };
    ops.allocate = () => { throw new FS.ErrnoError(43); };
    node.stream_ops = ops;
  }

  (Module.preRun ??= []).push((mod) => {
    const FS = mod.FS;
    mod.addRunDependency('bolsillo-pack');
    try { FS.mkdir('/pack'); } catch {}
    packP.then(async (pack) => {
      if (useSnapshot && snap.disk !== pack.data) throw new Error(`la instantánea es de otro disco (${snap.disk}); abre con ?snap=0`);
      const wanted = pack.files.filter((f) => f.name !== LAZY && !f.name.endsWith('/vm.state')
        && !(noBios && f.name.endsWith('/edk2-aarch64-code.fd')));
      let done = 0;
      const total = wanted.reduce((a, f) => a + f.end - f.start, 0);
      await Promise.all(wanted.map(async (f) => {
        const bytes = await fetchRange(pack.data, f.start, f.end);
        FS.createDataFile(f.name, null, bytes, true, true, true);
        done += bytes.length;
        mod.setStatus?.(`Descargando el Linux… ${Math.round(done / 1048576)} de ${Math.round(total / 1048576)} MB`);
      }));
      const disk = pack.files.find((f) => f.name === LAZY);
      if (disk) lazyDisk(FS, pack.data, disk.start, disk.end - disk.start, disk.chunk === CHUNK ? disk.crc : null);
      if (useSnapshot) lazyDisk(FS, snap.file, 0, snap.size, snap.crc, 'vm.state', true);
      mod.removeRunDependency('bolsillo-pack');
    }).catch((e) => {
      console.error('[bolsillo] paquete:', e);
      mod.setStatus?.(`No se pudo descargar el Linux: ${e.message}`);
      window.bolsillo?.events?.push({ name: 'error', t: 0, msg: e.message });
    });
  });
})();
