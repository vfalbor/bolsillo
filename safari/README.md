# Bolsillo en Safari (experimental)

Bolsillo en un iPhone sin instalar nada. Un Linux aarch64 entero (Alpine con Node 24, git y Claude Code) corre dentro de Safari, en QEMU compilado a WebAssembly con [container2wasm](https://github.com/container2wasm/container2wasm). La página arranca desde una instantánea con el Linux y Claude Code ya cargados. Muestra un chat con el inicio de sesión guiado y la pestaña de Apps.

Hace falta un servidor propio. Sirve el disco por trozos y da red al Linux. También guarda una copia de las apps de cada iPhone. Más detalles y medidas en [docs/PLAN-SAFARI.md](../docs/PLAN-SAFARI.md).

## Piezas

| Fichero | Qué hace |
|---|---|
| `gateway.js` | Servidor sin dependencias, con un único origen (COOP/COEP) para la página, el relé de red, las apps (`/p/<puerto>/`), el inicio de sesión con Claude (`/vm/login`) y las copias de las apps (`/vm/datos/<clave>`) |
| `web/` | La página: chat, barra de carga, terminal y el cargador por trozos (`lazy-load.js`) |
| `image/` | La imagen del Linux: `Dockerfile`, el arranque (`start.sh`) y el puente con el chat (`chat.sh`) |
| `make-pack.mjs`, `patch-load.mjs`, `make-hot.mjs`, `warm-z.mjs` | Preparan el disco que genera container2wasm para descargarlo por trozos |
| `make-snapshot.py`, `ws-bridge.mjs`, `publish-snapshot.mjs` | Hacen la instantánea con Claude cargado en QEMU nativo, la prueban y la publican |
| `c2w-init-desmontar-9p.patch` | Parche del init de container2wasm: QEMU no deja guardar la máquina con 9p montado |

## Montarlo

1. Prepara la imagen: `sh safari/image/preparar.sh <binario de Claude Code para linux-arm64-musl>`. Después, `docker build --platform linux/arm64 -t bolsillo-safari:arm64 safari/image`.
2. Compílala a WebAssembly con container2wasm v0.8.4, con el parche aplicado a su código:

   ```
   c2w --to-js --target-arch=aarch64 --assets <c2w parcheado> --build-arg VM_MEMORY_SIZE_MB=1024 bolsillo-safari:arm64 safari/build/base/htdocs/
   ```

3. Prepara el disco: `node safari/make-pack.mjs`, `node safari/patch-load.mjs` y `node safari/warm-z.mjs`.
4. Haz y publica la instantánea. Para crearla y probarla, `python3 safari/make-snapshot.py [--probar] <carpeta del disco> vm.state 768 2`. Para publicarla, `node safari/publish-snapshot.mjs vm.state bolsillo-snap-v1 768 2`.
5. Arranca la red con `c2w-net --listen-ws 127.0.0.1:8890 -p 127.0.0.1:27700:7700 …`.
6. Arranca la puerta con `PORT=8180 RELAY_PORT=8890 PORT_OFFSET=20000 GATEWAY_TOKEN=… node safari/gateway.js`, detrás de HTTPS.
7. Abre `/vm/probar.html?t=<token>` en el iPhone.

## Límites conocidos

- La primera visita baja unos 80–100 MB.
- La CPU va emulada, así que todo es varias veces más lento que en Android.
- Sin conexión no funciona: la página y la red del Linux pasan por el servidor.
- El binario oficial de Claude Code (Bun) falla en el emulador del navegador. Se usa la versión en JavaScript (2.1.112) sobre Node.
