# Bolsillo for Safari: an arm64 Linux inside the iPhone

Goal: that on an iPhone, with Safari alone, there's a "Linux" where Claude Code installs and is used
**just like on a PC** (`curl … | bash` or `npm install -g @anthropic-ai/claude-code`, then `claude`),
and that the same environment is the store for the apps people create. Reviewed on Oct 18, 2026.

## 1. The fact that rules everything: what Claude Code is today

Checked by downloading the official package (`@anthropic-ai/claude-code` 2.1.302):

- Since 2.1.1xx–2.1.200 it's no longer JavaScript (`cli.js`): it's a **native executable** per
  platform, generated with `bun build --compile`. It carries **Bun 1.4.4** (with the
  JavaScriptCore engine) and Claude Code's code.
- Linux arm64 musl version: **265 MB**, aarch64 ELF, it only depends on `libc.musl-aarch64.so.1`.
  Segments: ~82 MB of code, ~166 MB of data.
- It accepts engine options through environment variables (`JSC_useJIT`, `BUN_JSC_*`).
- License: "© Anthropic PBC. All rights reserved", subject to its legal agreements.

Conclusion: for the install to be **transparent** we have to run **that official binary
untouched**. The only way is making Safari behave like an **aarch64 Linux**: emulating the ARM64 CPU
and Linux system calls. It's also the cleanest option legally: the official program is used,
downloaded by the official installer, without extracting or modifying it.

## 2. How it's done: ARM64 → WebAssembly → the iPhone's CPU

```
Claude Code ARM64 binary
   │  dynamic translator (JIT): blocks of ARM64 instructions → WebAssembly
   ▼
WebAssembly  ──(Safari compiles it with its JIT)──▼  native ARM64 instructions on the iPhone
```

The iPhone's CPU ends up doing the work, but through two translations. It's **emulation** (slower
than native), not virtualization: Safari doesn't allow running ARM code directly.

**This already exists as a base:** QEMU ported to WebAssembly (the *qemu-wasm* project, presented at
FOSDEM 2025) with AArch64 guests and a JIT (TCG) that generates WebAssembly, plus *container2wasm*,
which turns a container image into something that boots in the browser. The WebAssembly JIT isn't in
upstream QEMU yet (upstream QEMU only has the interpreter mode, 32-bit).

## 3. Two possible architectures

| | **A. Full machine** (QEMU system) | **B. Processes only** (QEMU *linux-user* + our own kernel) |
|---|---|---|
| What's emulated | CPU + real Linux kernel + disk | CPU; system calls are handled by our own kernel in JS |
| Transparency | Total: it's a real Linux (apk/apt, bash, git, curl, npm, official installer) | High, but the calls programs use have to be implemented (~150) |
| Memory | Guest RAM lives inside WebAssembly: kernel + cache + programs | Only the processes'; much less |
| Speed | Slower (emulated MMU) | Faster |
| Effort | **Low for the prototype**: it exists today | High: months |

**Recommendation:** start with **A** (a prototype in days with what already exists) to find out as
soon as possible whether Claude Code boots and answers on an iPhone; move to **B** only if A doesn't
fit in memory or is too slow.

## 4. The four pieces that make it "like a Linux"

1. **CPU and system**: QEMU-wasm with an aarch64 Alpine Linux (musl, light; it matches Claude Code's
   musl binary). `uname -m` says `aarch64`, so npm and the official installer pick the right binary
   on their own.
2. **Persistent disk**: the Linux disk is kept in the browser's storage (OPFS), in blocks, so what's
   installed is still there when you open it again.
3. **Network**: a native program opens its own TCP/TLS connections, and a website can't. Clean
   solution: a small **WebSocket↔TCP relay** (on our server or the user's) that only passes bytes;
   TLS goes end to end inside Linux, so the relay doesn't see the content. It's the only piece
   outside the iPhone.
4. **Ports**: the apps the user creates listen on Linux ports; a Service Worker exposes them to
   Safari as pages (`/app/<id>/`), which can be added to the home screen. On top sits the Bolsillo
   panel, which is the store.

## 5. What can go wrong (and how it's measured)

- **Memory** (risk number one). 32-bit WebAssembly has a 4 GB ceiling and, on the iPhone, Safari in
  practice gives between ~200 MB and ~1 GB per page and kills the tab when it goes over; I couldn't
  confirm that Safari has 64-bit memory (Memory64) yet. Claude Code needs its ~265 MB plus its
  JavaScript engine's memory plus Linux itself. Possible help: starting Bun with the JavaScriptCore
  JIT turned off (`JSC_useJIT=0`: less memory and no self-modifying code, which is what an emulator
  handles worst), smaller memory reservations, and a minimal Alpine. It has to be measured.
- **Speed**: two chained translations, and JavaScriptCore in interpreter mode. Claude Code's startup
  can take a long time; after that almost all the time is waiting for the API, which doesn't depend
  on the CPU. It has to be measured.
- **iOS freezes Safari** when switching apps or locking the screen: Linux pauses (nothing is lost if
  the disk is in OPFS, but the turn gets cut). iOS "Lockdown Mode" turns off the WebAssembly JIT and
  would make it unusable.
- **QEMU's WebAssembly JIT isn't official** yet: we depend on a branch.
- **License and use**: the official binary runs unmodified; even so, it's worth confirming with
  Anthropic that this is acceptable and whether the Pro/Max subscription is valid in this environment.

## 6. Plan by phases

| Phase | Deliverable | Rough duration | Gate |
|---|---|---|---|
| **0. Prototype A on a PC** | Alpine aarch64 image + official Claude Code, converted with container2wasm; boots in a desktop browser and `claude --version` answers | 1 week | If it doesn't boot even on desktop, evaluate B |
| **1. Prototype A on an iPhone** | The same image in Safari on the iPhone; measure memory, boot time, time for `claude --version` and for a real question; try `JSC_useJIT=0` | 1–2 weeks | **Key decision**: if it fits and answers in acceptable time, go on with A; if not, B |
| **2. Network and disk** | WebSocket↔TCP relay, persistent disk in OPFS, install with the official installer inside the iPhone | 2–3 weeks | `curl … \| bash` and `claude` work after closing and reopening Safari |
| **3. Bolsillo inside** | Node + Bolsillo's `server.js` in Linux; a Service Worker exposing the ports; the panel as a PWA | 3–4 weeks | Ask for an app from the iPhone and open it from the home screen |
| **4. Store** | Catalog, install/open, share and remix by link or QR, export an app as a standalone website | 3–4 weeks | An app made on one iPhone installs on another |
| **5. Optimize** (or **B** if phase 1 calls for it) | Less memory and more speed; if it's B: our own kernel + QEMU linux-user | 1–2 months (B: 3–5) | — |

Phases 0 and 1 answer the question that matters (does the official Claude Code run on an iPhone?)
in about 2–3 weeks, before investing in the rest.

## 7. Fallback

If emulation doesn't fit on an iPhone: the "remote screen" mode (Bolsillo on a PC or server and the
iPhone as the panel, already possible today) or our own JavaScript agent on the Claude API, which
would run at native speed in Safari but wouldn't be Claude Code.

## 8. Real measurements (Oct 18, 2026, WebKit 26 and Chromium on Linux, `safari/test-vm.mjs`)

Prototype A: QEMU-wasm (container2wasm 0.8.4) with Alpine aarch64, Node 24, Claude Code 2.1.302 and Bolsillo.

| Configuration | WebKit (Safari's engine) | Chromium |
|---|---|---|
| Original: full preload (660 MB) + 1024 MB RAM + snapshot | 2766 MB just starting the module | — |
| On-demand disk, 256 MB RAM, no UEFI | >1500 MB (dies) | 957 MB stable, but the kernel doesn't boot without UEFI |
| On-demand disk, 256 MB RAM, with UEFI, cold boot | — | peak 1232 MB; the kernel boots and the disk downloads 25 MB in 13 requests |
| Same with 448 MB RAM and a 64 MB JIT buffer | — | keeps growing and passes 1500 MB at 71 s |
| Same with a 16 MB JIT buffer | — | grows more slowly (1123 → 1486 MB in 90 s) and passes 1500 MB at 99 s |

How it splits up, matched against the first two rows (the measured difference, 1388 MB, matches the
expected one, 1391 MB):

- **Linux RAM**: reserved **in full** at boot (Emscripten zeroes the memory QEMU asks for). Every MB
  of `-m` is a MB of the tab.
- **Disk** (`rootfs.bin`, 467 MB): with `web/lazy-load.js` it no longer takes up the tab; only what's
  read is downloaded in 1 MB chunks, with a cache cap (48 MB by default).
- **Snapshot** (`vm.state`, 92 MB) and **UEFI firmware** (64 MB): only needed to boot in seconds; on a
  cold boot the snapshot isn't needed. Without UEFI this kernel doesn't boot.
- **QEMU-wasm's own base**: ~1.1 GB in WebKit (~0.6 GB in Chromium), growing while Linux runs new
  code. It's the heaviest part and doesn't depend on Linux: QEMU's wasm (58 MB) compiled by the
  engine plus the thousands of small modules its JIT (TCG→wasm) generates. The difference between
  WebKit and Chromium (about +500 MB) is the engine's. qemu-wasm creates a `WebAssembly.Module` and an
  `Instance` per hot block (`instantiate_wasm` in `out.js`) and only releases them when it flushes its
  cache **and** the browser's garbage collector runs, which doesn't see that memory; that's why it
  doesn't level off.

Conclusion: on an iPhone the realistic minimum is **~1.5–1.8 GB** per tab. Whether Safari on the
iPhone allows that is exactly what the phase 1 test measures; Linux's WebKit doesn't have iOS's
limits. Trimming the base requires rebuilding QEMU-wasm (fewer devices and a higher threshold to
move blocks from the interpreter to the JIT), which is phase 5 work.

## 9. Bolsillo as an embedded operating system

Goal (Oct 18): that Bolsillo be a **complete, independent OS** inside the browser. Store apps can
install whatever they need (for example a database) and Claude Code runs on the same system.

### What architecture A already gives

It's a real Linux (kernel, Alpine, musl, `apk`), so everything that runs on an arm64 Alpine runs
here without porting: SQLite, PostgreSQL, MariaDB, Redis, Node, Python, background services and local
ports. An app that asks for "PostgreSQL" does `apk add postgresql` exactly as on a server. With
architecture B (processes only) each database would be a separate compatibility project: one more
reason to stay with A.

### What's missing to make it an OS (in order)

1. **A persistent, writable disk.** Today the base disk is read-only and what's written lives in
   Linux's RAM (overlay on tmpfs): it's lost on close and every MB installed is a MB of memory.
   Design:
   - *base disk* (system, Claude Code): read-only, served in chunks and cacheable on a CDN; updated
     by switching versions;
   - *user disk* (a second virtio disk, ext4, e.g. a sparse 4 GB): kept in **OPFS** in blocks. On
     top, an overlayfs makes the whole system look writable (`/usr`, `/var/lib`, `/root`); `apk add`
     and database data end up here.
   - Technique: synchronous OPFS only exists in Workers. There are two paths. One is rebuilding
     QEMU-wasm with WASMFS and its OPFS backend (the right one). The other, without rebuilding, is
     for the main thread to save to OPFS in the background the chunks Linux writes, on top of
     `lazy-load.js`, which already keeps written chunks apart. That second path risks losing the last
     few seconds if iOS kills the tab. Databases survive that (journaling or WAL) as long as write
     order is respected.
2. **System services.** A supervisor (OpenRC or s6, already in Alpine) starts the databases and the
   installed apps on every boot, with a fixed port per app.
3. **Store app format.** `bolsillo.json` extends what already exists: system dependencies
   (`"system": ["postgresql16"]`), services it needs (`"services": {"db": "postgresql"}`), port and
   data. On install: `apk add` of the dependencies, its own database and user in the shared service
   (not one PostgreSQL per app: there's no memory for that) and registering the service. On
   uninstall everything is removed, database included. Exporting or importing an app and its data
   goes to a file (iOS Files).
4. **Apps visible in Safari without a server.** Today `/p/<port>/` goes through the server's gateway.
   To be independent: a **Service Worker** that hands each `/p/<port>/…` request to the browser's own
   network stack, towards the Linux port, without leaving the iPhone. container2wasm already has the
   piece: the TCP/IP stack in wasm from `c2w-net-proxy`.
5. **Network independence, with its limits.** Safari can't open TCP, and no design changes that:
   - *Offline*, everything local works: apps, databases, services and the communication between them.
   - *The Claude API* with no server in between: Anthropic's API allows calls from the browser
     (CORS). `ANTHROPIC_BASE_URL` points at a local Linux port that the browser forwards with
     `fetch`. It works with an API key; with the Pro/Max subscription (OAuth) it has to be checked.
   - *Installing packages* (`apk`, `npm`, `git clone`): public repositories don't allow CORS. That
     needs the WebSocket↔TCP relay (what exists now) or **our own CORS mirror** of the packages the
     store uses: static files on any CDN, with no server of our own running.
6. **iOS limits that affect an OS.** Safari freezes the tab in the background, so services stop
   (there are no 24/7 servers on the iPhone). Safari deletes the data of websites not opened in 7
   days, unless it's **added to the home screen**, which is mandatory to not lose the disk. Lockdown
   Mode removes the JIT and makes it unusable. And the OPFS quota is large but finite.

### Memory budget for a useful OS

QEMU-wasm base (1.1 GB in WebKit) + Linux RAM: kernel and system ~60 MB, Claude Code ~250–350 MB
while working, PostgreSQL ~40–80 MB, Node with the panel ~60 MB and each app ~30–80 MB. With 512–768 MB
of RAM, Claude Code, a database and a couple of apps fit: **~1.7–2 GB per tab**. The iPhone test says
whether that fits; if it doesn't, option C remains.

### Alternative C: CheerpX (WebVM)

An x86 virtual machine in wasm by Leaning Technologies, mature, with a persistent disk in IndexedDB
and without reserving guest RAM up front (it emulates processes on its own kernel, like B). Claude
Code has a Linux x64 musl binary. It uses much less memory than QEMU-wasm, but its license is free
only for personal or non-commercial use (commercial use is paid), its network goes through Tailscale
(also a relay) and it has to be checked that Bun's JIT works on top. It deserves a one-day test if
phase 1 fails on memory.

### Recommendation

1. Tomorrow: the iPhone test (`/vm/try.html`) decides between going on with A or looking at C.
2. If A fits: a persistent user disk in OPFS, then services and an app format with system
   dependencies (the database as the first case), then the Service Worker for the apps and the
   Claude API without a relay.
3. The relay and the package mirror remain as the only external pieces, both stateless.
