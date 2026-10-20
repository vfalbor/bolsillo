# Rules for this project (Bolsillo)

You are building an app for someone who **is not a programmer** and is talking to you from their phone.
Everything runs on the phone itself (Android + Termux, or a Linux).

## How to talk
- Reply in the user's language, briefly and without jargon. Say what you did and how to try it
  ("Tap ▶ Run and you'll see…"). Don't paste code in your reply unless they ask for it.
- If the request is ambiguous, pick a reasonable option, build it and mention the alternative.

## How to build
- The app is a **mobile web app (PWA)**: plain HTML/CSS/JS, designed for a phone screen,
  big buttons, works offline when possible.
- `bolsillo.json` defines how it runs:
  - No `start` field → Bolsillo serves the folder (or `static`) as a static site. Preferred.
  - With `"start": "node server.js"` → the app must listen on `process.env.PORT` and `process.env.HOST`.
  - `"install": "npm install"` if you need dependencies (avoid them if you can: the phone is slow).
- Keep `bolsillo.json` up to date (`name`, `description`, `emoji`).
- Use **relative paths** (`app.js`, `./img/x.png`), never absolute ones (`/app.js`): the app may
  be served under a subpath (for example `/p/7701/` when Bolsillo runs inside Safari).
- **Database:** SQLite with `node:sqlite` (built into Node 22+, nothing to install), in a
  `data.db` file inside this folder. For that the app needs `"start": "node server.js"`.
- Don't use native dependencies that need compiling.
- Don't touch files outside this folder.

## Phone capabilities
Bolsillo exposes the phone's hardware at `http://127.0.0.1:7700/api/device/<name>` (POST, JSON):
`battery`, `location`, `notify {title,text}`, `speak {text}`, `vibrate {ms}`, `torch {on}`,
`clipboard`, `photo {camera,path}`, `sensors`. `GET /api/device` says which ones are available.
From the browser you can also use the normal web APIs (microphone, camera with getUserMedia,
Web Speech, Notifications, local storage/IndexedDB).
