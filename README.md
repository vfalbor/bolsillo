# 👜 Bolsillo

**Tu taller de apps en el móvil.** Le dices a Claude Code lo que quieres ("hazme la app de
audiolibros de mi amigo, pero con cuentos de dinosaurios") y la construye y la ejecuta **en tu
propio teléfono**. Sin PC y sin nube ajena: el código es tuyo.

- 🧭 **Tienda de apps**: *Mis apps* (como una pantalla de inicio), *Descubrir* (apps para obtener o
  remezclar), *Crear* (describe tu idea) y *Ajustes*
- 💬 Chat en lenguaje normal con Claude Code (una sesión por app, recuerda el contexto)
- ▶️ Cada app se abre a pantalla completa; con **📲 Poner en el inicio** queda como un icono más del móvil
- ↶ Cada cambio queda guardado (git): deshaz con un toque
- 📱 Hardware del móvil para tus apps: voz, vibración, linterna, avisos, batería, ubicación, portapapeles
- 🐧 Por debajo hay un **Linux de verdad** (Ubuntu en proot) con Node.js, git y Claude Code

## Instalar en Android (APK)

1. Descarga `bolsillo-0.2.0.apk` en el móvil y ábrelo (acepta "instalar apps de origen desconocido").
2. La primera vez prepara su Linux: descarga Ubuntu Base (~30 MB), Node.js y Claude Code. Necesita
   conexión y unos minutos; después arranca en segundos.
3. En **Ajustes → Iniciar sesión con Claude**: se abre el navegador, autorizas y pegas el código.
   Vale una cuenta Pro/Max, o una clave de API.

Requisitos: Android 8 o superior con Linux (kernel) 4.4 o más nuevo — casi todos los móviles
desde 2018; si no, la app lo dice al arrancar —, procesador de 64 bits (arm64; x86_64 para el
emulador), ~1,5 GB libres. Compatibilidad probada versión a versión en
[docs/COMPATIBILIDAD.md](docs/COMPATIBILIDAD.md).

> **Android 12+ y "procesos fantasma".** Android mata apps que lanzan muchos procesos hijos
> (Claude Code, git y node lo hacen). Si ves que Bolsillo se corta mientras Claude trabaja, activa
> en *Opciones de desarrollador* "Desactivar restricciones de procesos secundarios", o desde un PC:
> `adb shell settings put global settings_enable_monitor_phantom_procs false`.

### Probar en emuladores

```bash
scripts/test-emulator.sh "system-images;android-34;google_apis;x86_64"
```

Arranca un emulador limpio, instala el APK y recorre el flujo completo (Linux, Node, Claude Code,
crear y abrir una app, puente del móvil, segundo plano). Deja informe y captura en
`test/emulator-results/<versión>/`.

### Compilar el APK

```bash
./scripts/build-apk.sh     # → android/app/build/outputs/apk/release/bolsillo-<versión>.apk
```

Necesita JDK 17+ y el SDK de Android (`ANDROID_HOME`). Descarga `proot` ya compilado para Android
(de Termux) la primera vez. Firma con `BOLSILLO_KEYSTORE`/`BOLSILLO_KEYSTORE_PASS` si existen; si no,
con la clave de depuración.

### Alternativa: Termux

Si prefieres Termux: instala **Termux** y **Termux:API** desde F-Droid y ejecuta
[`scripts/install-termux.sh`](scripts/install-termux.sh). El hardware llega vía `termux-*`.

## Probar en un ordenador (Linux/macOS)

```bash
npm start          # → http://127.0.0.1:7700
npm test
```

Variables: `PORT` (7700), `HOST` (127.0.0.1; con `0.0.0.0` exige token y lo imprime),
`BOLSILLO_DATA` (dónde se guardan los proyectos), `BOLSILLO_APPS_PORT` (7701+), `CLAUDE_BIN`,
`BOLSILLO_BRIDGE`/`BOLSILLO_BRIDGE_TOKEN` (puente al hardware; los pone la app de Android).

## Cómo funciona

```
┌──────────────── APK de Bolsillo ────────────────────────────────────────────┐
│ WebView (tienda + chat) ──HTTP──► 127.0.0.1:7700                             │
│                                                                              │
│ LinuxService (servicio en primer plano)                                      │
│   └─ proot ─► Ubuntu Base (files/linux)                                      │
│        └─ node /opt/bolsillo/server.js                                       │
│             ├─► claude -p --output-format stream-json   (en cada proyecto)   │
│             ├─► Runner: cada app en su puerto (7701+)                        │
│             └─► /api/device/* ──HTTP+token──► DeviceBridge (Java, :7699)     │
│                                                 voz, vibración, linterna,    │
│                                                 avisos, accesos directos…    │
│ AppActivity: cada app abierta desde su icono, en su propia ventana           │
└──────────────────────────────────────────────────────────────────────────────┘
```

- `android/`: la app nativa (Java, sin dependencias). `Linux.java` arma el comando `proot`,
  `LinuxService.java` instala y mantiene vivo el Linux, `DeviceBridge.java` expone el hardware,
  `assets/setup.html` es la pantalla de primera instalación.
- El servidor Node (`server.js`, `lib/`, `public/`, `templates/`) viaja dentro del APK y se copia al
  Linux cuando cambia la versión.
- Cada proyecto incluye un `CLAUDE.md` con las reglas del entorno y un `bolsillo.json` que dice
  cómo ejecutarlo. Plantillas en `templates/<id>/` (`name`, `emoji`, `category`, `description`);
  `_shared/` se copia en todos los proyectos.

**Por qué `targetSdk 28`:** desde Android 10, las apps que apuntan a versiones nuevas no pueden
ejecutar programas desde sus propios ficheros, y un Linux en el móvil necesita justo eso (Termux
hace lo mismo). Se instala sin problema como APK; Google Play no lo aceptaría.

Plan completo y fases: [`docs/PLAN.md`](docs/PLAN.md).
