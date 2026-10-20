# 👜 Bolsillo

**Your app workshop on your phone.** You tell Claude Code what you want ("make me my friend's
audiobook app, but with dinosaur stories") and it builds it and runs it **on your own phone**.
No PC and no third-party cloud: the code is yours.

- 🧭 **App store**: *My apps* (like a home screen), *Discover* (apps to get or remix), *Create*
  (describe your idea) and *Settings*
- 💬 Plain-language chat with Claude Code (one session per app, it remembers the context)
- ▶️ Every app opens full screen; with **📲 Add to home screen** it becomes one more icon on the phone
- ↶ Every change is saved (git): undo with one tap
- 📱 Phone hardware for your apps: voice, vibration, flashlight, notifications, battery, location, clipboard
- 🐧 Underneath there's a **real Linux** (Ubuntu in proot) with Node.js, git and Claude Code

🌐 Website and video: **https://vfalbor.github.io/bolsillo/** · 🍏 iPhone with nothing to install (experimental): [safari/](safari/README.md)

## Install on Android (APK)

1. Download `bolsillo-0.3.0.apk` on the phone and open it (allow "install unknown apps").
2. The first time it sets up its Linux: it downloads Ubuntu Base (~30 MB), Node.js and Claude Code.
   It needs a connection and a few minutes; after that it starts in seconds.
3. In **Settings → Sign in with Claude**: the browser opens, you authorize and paste the code.
   A Pro/Max account works, or an API key.

Requirements: Android 8 or later with Linux (kernel) 4.4 or newer — almost every phone since
2018; if not, the app says so at startup —, a 64-bit processor (arm64; x86_64 for the emulator),
~1.5 GB free. Compatibility tested version by version in
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

> **Android 12+ and "phantom processes".** Android kills apps that launch many child processes
> (Claude Code, git and node do). If Bolsillo gets cut off while Claude is working, turn on
> "Disable child process restrictions" in *Developer options*, or from a PC:
> `adb shell settings put global settings_enable_monitor_phantom_procs false`.

### Test on emulators

```bash
scripts/test-emulator.sh "system-images;android-34;google_apis;x86_64"
```

Boots a clean emulator, installs the APK and walks through the whole flow (Linux, Node, Claude
Code, creating and opening an app, phone bridge, background). Leaves a report and a screenshot in
`test/emulator-results/<version>/`.

### Build the APK

```bash
./scripts/build-apk.sh     # → android/app/build/outputs/apk/release/bolsillo-<version>.apk
```

Needs JDK 17+ and the Android SDK (`ANDROID_HOME`). Downloads a prebuilt Android `proot` (from
Termux) the first time. Signs with `BOLSILLO_KEYSTORE`/`BOLSILLO_KEYSTORE_PASS` if they exist;
otherwise with the debug key.

### Alternative: Termux

If you prefer Termux: install **Termux** and **Termux:API** from F-Droid and run
[`scripts/install-termux.sh`](scripts/install-termux.sh). Hardware access goes through `termux-*`.

## Try it on a computer (Linux/macOS)

```bash
npm start          # → http://127.0.0.1:7700
npm test
```

Variables: `PORT` (7700), `HOST` (127.0.0.1; with `0.0.0.0` it requires a token and prints it),
`BOLSILLO_DATA` (where projects are stored), `BOLSILLO_APPS_PORT` (7701+), `CLAUDE_BIN`,
`BOLSILLO_BRIDGE`/`BOLSILLO_BRIDGE_TOKEN` (bridge to the hardware; the Android app sets them).

## How it works

```
┌──────────────── Bolsillo APK ────────────────────────────────────────────────┐
│ WebView (store + chat) ──HTTP──► 127.0.0.1:7700                              │
│                                                                              │
│ LinuxService (foreground service)                                            │
│   └─ proot ─► Ubuntu Base (files/linux)                                      │
│        └─ node /opt/bolsillo/server.js                                       │
│             ├─► claude -p --output-format stream-json   (in each project)    │
│             ├─► Runner: each app on its own port (7701+)                     │
│             └─► /api/device/* ──HTTP+token──► DeviceBridge (Java, :7699)     │
│                                                 voice, vibration, flashlight,│
│                                                 notifications, shortcuts…    │
│ AppActivity: each app opened from its icon, in its own window                │
└──────────────────────────────────────────────────────────────────────────────┘
```

- `android/`: the native app (Java, no dependencies). `Linux.java` builds the `proot` command,
  `LinuxService.java` installs Linux and keeps it alive, `DeviceBridge.java` exposes the hardware,
  `assets/setup.html` is the first-install screen.
- The Node server (`server.js`, `lib/`, `public/`, `templates/`) travels inside the APK and is copied
  into Linux when the version changes.
- Every project includes a `CLAUDE.md` with the environment's rules and a `bolsillo.json` that says
  how to run it. Templates live in `templates/<id>/` (`name`, `emoji`, `category`, `description`);
  `_shared/` is copied into every project.

**Why `targetSdk 28`:** since Android 10, apps targeting newer versions can't run programs from
their own files, and a Linux on the phone needs exactly that (Termux does the same). It installs
fine as an APK; Google Play wouldn't accept it.

Full plan and phases: [`docs/PLAN.md`](docs/PLAN.md).
