# Bolsillo for Safari (experimental)

Bolsillo on an iPhone with nothing to install. A whole aarch64 Linux (Alpine with Node 24, git and Claude Code) runs inside Safari, in QEMU compiled to WebAssembly with [container2wasm](https://github.com/container2wasm/container2wasm). The page boots from a snapshot with Linux and Claude Code already loaded. It shows a chat with guided sign-in and the Apps tab.

It needs your own server. The server serves the disk in chunks and gives Linux its network. It also keeps a backup of each iPhone's apps. More details and measurements in [docs/PLAN-SAFARI.md](../docs/PLAN-SAFARI.md).

## Pieces

| File | What it does |
|---|---|
| `gateway.js` | Dependency-free server with a single origin (COOP/COEP) for the page, the network relay, the apps (`/p/<port>/`), the Claude sign-in (`/vm/login`) and the app backups (`/vm/data/<key>`) |
| `web/` | The page: chat, loading bar, terminal and the chunk loader (`lazy-load.js`) |
| `image/` | The Linux image: `Dockerfile`, the boot script (`start.sh`) and the bridge to the chat (`chat.sh`) |
| `make-pack.mjs`, `patch-load.mjs`, `make-hot.mjs`, `warm-z.mjs` | Prepare the disk container2wasm generates so it can be downloaded in chunks |
| `make-snapshot.py`, `ws-bridge.mjs`, `publish-snapshot.mjs` | Make the snapshot with Claude loaded in native QEMU, test it and publish it |
| `c2w-init-unmount-9p.patch` | Patch for container2wasm's init: QEMU won't save the machine with 9p mounted |

## Setting it up

1. Prepare the image: `sh safari/image/prepare.sh <Claude Code binary for linux-arm64-musl>`. Then `docker build --platform linux/arm64 -t bolsillo-safari:arm64 safari/image`.
2. Compile it to WebAssembly with container2wasm v0.8.4, with the patch applied to its source:

   ```
   c2w --to-js --target-arch=aarch64 --assets <patched c2w> --build-arg VM_MEMORY_SIZE_MB=1024 bolsillo-safari:arm64 safari/build/base/htdocs/
   ```

3. Prepare the disk: `node safari/make-pack.mjs`, `node safari/patch-load.mjs` and `node safari/warm-z.mjs`.
4. Make and publish the snapshot. To create and test it, `python3 safari/make-snapshot.py [--test] <disk folder> vm.state 768 2` (the test talks to the gateway at `SNAP_SERVER`). To publish it, `node safari/publish-snapshot.mjs vm.state bolsillo-snap-v1 768 2`.
5. Start the network with `c2w-net --listen-ws 127.0.0.1:8890 -p 127.0.0.1:27700:7700 …`.
6. Start the gateway with `PORT=8180 RELAY_PORT=8890 PORT_OFFSET=20000 GATEWAY_TOKEN=… node safari/gateway.js`, behind HTTPS. App backups go to `safari/data/` (or `DATA_DIR`).
7. Open `/vm/try.html?t=<token>` on the iPhone.

## Known limits

- The first visit downloads about 80–100 MB.
- The CPU is emulated, so everything is several times slower than on Android.
- It doesn't work offline: the page and the Linux network go through the server.
- The official Claude Code binary (Bun) fails in the browser emulator. The JavaScript version (2.1.112) on Node is used instead.
