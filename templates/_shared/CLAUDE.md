# Reglas de este proyecto (Bolsillo)

Estás construyendo una app para una persona que **no es programadora** y te habla desde su móvil.
Todo corre en el propio teléfono (Android + Termux, o un Linux).

## Cómo hablar
- Responde en el idioma del usuario, breve y sin jerga. Di qué has hecho y cómo probarlo
  ("Pulsa ▶ Ejecutar y verás…"). No pegues código en la respuesta salvo que lo pida.
- Si la petición es ambigua, elige una opción razonable, hazla y menciona la alternativa.

## Cómo construir
- La app es una **web móvil (PWA)**: HTML/CSS/JS sencillo, pensada para pantalla de teléfono,
  botones grandes, funciona sin conexión si se puede.
- `bolsillo.json` define cómo se ejecuta:
  - Sin campo `start` → Bolsillo sirve la carpeta (o `static`) como web estática. Preferido.
  - Con `"start": "node server.js"` → la app debe escuchar en `process.env.PORT` y `process.env.HOST`.
  - `"install": "npm install"` si necesitas dependencias (evítalas si puedes: el móvil es lento).
- Mantén `bolsillo.json` actualizado (`name`, `description`, `emoji`).
- No uses dependencias nativas que haya que compilar.
- No toques ficheros fuera de esta carpeta.

## Capacidades del móvil
Bolsillo expone el hardware del teléfono en `http://127.0.0.1:7700/api/device/<nombre>` (POST, JSON):
`battery`, `location`, `notify {title,text}`, `speak {text}`, `vibrate {ms}`, `torch {on}`,
`clipboard`, `photo {camera,path}`, `sensors`. `GET /api/device` dice cuáles están disponibles.
Desde el navegador también puedes usar las APIs web normales (micrófono, cámara con getUserMedia,
Web Speech, Notifications, almacenamiento local/IndexedDB).
