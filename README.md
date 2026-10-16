# 👜 Bolsillo

**Tu taller de software en el móvil.** Le dices a Claude Code lo que quieres —"hazme la app de
audiolibros de mi amigo, pero con cuentos de dinosaurios"— y la construye y la ejecuta **en tu
propio teléfono**. Sin PC, sin nube ajena: el código es tuyo.

- 💬 Chat en lenguaje normal con Claude Code (una sesión por app, recuerda el contexto)
- 🎨 Plantillas para **remezclar** (empieza con *Audiolibros para peques*)
- ▶️ Ejecuta cada app en tu móvil y pruébala en la vista previa; instálala en la pantalla de inicio
- ↶ Cada cambio queda guardado (git): deshaz con un toque
- 📱 Acceso al hardware vía Termux:API (voz, notificaciones, linterna, ubicación, cámara…)
- 🪶 Cero dependencias npm: arranca en segundos incluso en móviles modestos

## Instalar en Android

1. Instala **Termux** y **Termux:API** desde F-Droid.
2. En Termux: `bash install-termux.sh` (ver [`scripts/install-termux.sh`](scripts/install-termux.sh)).
3. Inicia sesión en Claude Code una vez y luego ejecuta `bolsillo`.

Necesitas una cuenta de Claude (Pro/Max) o una API key.

## Probar en un ordenador (Linux/macOS)

```bash
npm start          # → http://127.0.0.1:7700
npm test
```

Variables: `PORT` (7700), `HOST` (127.0.0.1; con `0.0.0.0` exige token y lo imprime),
`BOLSILLO_DATA` (dónde se guardan los proyectos), `BOLSILLO_APPS_PORT` (7701+), `CLAUDE_BIN`.

## Cómo funciona

```
PWA móvil ──HTTP/SSE──► server.js ──► claude -p --output-format stream-json (en projects/<app>)
                           ├─► Runner: sirve/arranca cada app en su puerto
                           └─► /api/device/* ──► termux-* (hardware del móvil)
```

Cada proyecto incluye un `CLAUDE.md` con las reglas del entorno (hablar sin jerga, hacer PWAs,
usar `PORT`, capacidades del móvil) y un `bolsillo.json` que dice cómo ejecutarlo.

Plantillas: carpeta `templates/<id>/` con un `bolsillo.json` (`name`, `emoji`, `description`,
opcional `start`/`install`/`static`). `_shared/` se copia en todos los proyectos.

Plan completo y fases: [`docs/PLAN.md`](docs/PLAN.md).
