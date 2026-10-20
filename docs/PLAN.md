# Bolsillo — work plan

> Your software workshop on your phone: you ask Claude Code for apps in natural language,
> they're built and run **on your own phone**, and you can remix other people's.

## 1. What already exists (October 2026)

| Solution | What it does | What it lacks for this idea |
|---|---|---|
| Claude app (Code tab) | Mobile client for sessions in the cloud or on your PC (Remote Control) | The code doesn't run on the phone; it doesn't use its resources |
| Claude Code on Termux (claude-code-android) | Native Claude Code / in a proot Ubuntu inside Android | It's a terminal: for technical people only |
| AndCode, droid-harness | Mobile IDE with an agent + Ubuntu in proot | Made for programmers (diffs, files, shell) |
| Rork, Replit, Bolt, Lovable | Generate apps from prompts | Run in their cloud, paid, no access to the phone's hardware, you control nothing |

**Gap:** nobody combines a *local runtime on the phone* + *an interface for non-technical people* +
*a catalog of apps to remix* ("I want my friend's audiobook app, but with X").

## 2. Architecture

```
┌────────────── Android ──────────────────────────────────────┐
│  Termux (+ Termux:API)                                       │
│   └─ Bolsillo (Node, no dependencies)  127.0.0.1:7700         │
│        ├─ Mobile PWA: chat, projects, templates, preview      │
│        ├─ Agent: `claude -p --output-format stream-json`      │
│        │    one session per project (resumed with --resume)   │
│        ├─ Runner: starts each app on its own port (7701+)     │
│        └─ Device bridge: termux-* (TTS, notification,         │
│             battery, vibration, camera…) → /api/device/*      │
│  projects/<app>/  ← the user's code, each one with git        │
└──────────────────────────────────────────────────────────────┘
```

Decisions:
- **No npm dependencies** in the orchestrator → installs in seconds on Termux, nothing to compile on ARM.
- **Claude Code as the engine**, we don't reimplement the agent. It uses the user's subscription.
- **Apps = websites/PWAs** first (they "install" on the home screen, work offline);
  native APK in a later phase.
- Every project carries a `CLAUDE.md` that explains the environment's rules to the agent
  (port, `bolsillo.json`, available phone capabilities).
- Every change by the agent is a git commit → "undo" button.

## 3. Phases

| Phase | Deliverable | Status |
|---|---|---|
| 0 | Research + plan | ✅ |
| 1 | Orchestrator + PWA + templates (audiobooks, basic web), tested on Linux | ✅ |
| 2 | One-command Termux installer, Android 8–17 compatibility on emulators ([COMPATIBILITY](COMPATIBILITY.md)), own bridge instead of Termux:API | ✅ x86_64 emulators · pending: real arm64 phone and real Claude sign-in |
| 3 | Remix from a git URL / share a project (zip/QR), undo with git | pending |
| 4 | Own Android app (WebView + proot + Ubuntu Base) without Termux, app store, Claude sign-in from the app, shortcuts | ✅ v0.2 (tested on an x86_64 emulator) |
| 5 | Export to APK (Capacitor/TWA) and publish apps at a public URL (tunnel) | pending |

## 3b. Web or native (decision, Oct 2026)

- **Web only (PWA) isn't enough**: a browser can't launch processes, so neither Linux nor Claude Code.
- **Termux + PWA** works, but forces installing Termux from F-Droid and typing commands.
- **Chosen: a thin native APK + embedded Linux + web interface in a WebView.** The APK ships `proot`
  (built for Android by Termux), downloads Ubuntu Base the first time and installs Node.js and
  Claude Code. The interface is still HTML (the same as on the PC) and the native part adds what the
  web can't: keeping Linux alive (foreground service), hardware without Termux:API, per-app home
  screen icons and opening the Claude sign-in in the browser.
- Ubuntu (glibc) and not Alpine (musl): musl uses the `fork` call on x86_64 and Android blocks it for apps.

## 4. Risks

- **Agent permissions**: `acceptEdits` by default + an allowlist of commands (npm, node, git…). Optional "free" mode.
- **Phone resources**: battery and RAM; stop idle apps.
- **Android kills background processes**: foreground service + wake lock. On Android 12+ the
  "phantom process" limit can kill Claude; how to turn it off is documented.
- **Google Play**: `targetSdk 28` prevents publishing there; distributed as a direct APK.
- **Security**: the panel only listens on 127.0.0.1; on a local network it requires a token.
