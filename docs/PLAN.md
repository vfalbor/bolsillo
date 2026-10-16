# Bolsillo — plan de trabajo

> Tu taller de software en el móvil: le pides apps a Claude Code en lenguaje natural,
> se construyen y se ejecutan **en tu propio teléfono**, y puedes remezclar las de otros.

## 1. Qué existe ya (octubre 2026)

| Solución | Qué hace | Qué le falta para esta idea |
|---|---|---|
| App Claude (pestaña Code) | Cliente móvil de sesiones en la nube o de tu PC (Remote Control) | El código no corre en el móvil; no usa sus recursos |
| Claude Code en Termux (claude-code-android) | Claude Code nativo / en proot Ubuntu dentro de Android | Es una terminal: solo para técnicos |
| AndCode, droid-harness | IDE móvil con agente + Ubuntu en proot | Pensados para programadores (diffs, ficheros, shell) |
| Rork, Replit, Bolt, Lovable | Generan apps a partir de prompts | Corren en su nube, de pago, sin acceso al hardware del móvil, tú no controlas nada |

**Hueco:** nadie combina *runtime local en el móvil* + *interfaz para gente no técnica* +
*catálogo de apps para remezclar* ("quiero la app de audiolibros de mi amigo, pero con X").

## 2. Arquitectura

```
┌────────────── Android ──────────────────────────────────────┐
│  Termux (+ Termux:API)                                       │
│   └─ Bolsillo (Node, sin dependencias)  127.0.0.1:7700        │
│        ├─ PWA móvil: chat, proyectos, plantillas, vista previa │
│        ├─ Agente: `claude -p --output-format stream-json`     │
│        │    una sesión por proyecto (se reanuda con --resume)  │
│        ├─ Ejecutor: arranca cada app en su puerto (7701+)     │
│        └─ Puente de dispositivo: termux-* (TTS, notificación,  │
│             batería, vibración, cámara…) → /api/device/*       │
│  projects/<app>/  ← código del usuario, cada uno con git      │
└──────────────────────────────────────────────────────────────┘
```

Decisiones:
- **Sin dependencias npm** en el orquestador → instala en segundos en Termux, nada que compilar en ARM.
- **Claude Code como motor**, no reimplementamos el agente. Usa la suscripción del usuario.
- **Apps = webs/PWA** primero (se "instalan" en la pantalla de inicio, funcionan offline);
  APK nativo en una fase posterior.
- Cada proyecto lleva un `CLAUDE.md` que le explica al agente las reglas del entorno
  (puerto, `bolsillo.json`, capacidades del móvil disponibles).
- Cada cambio del agente queda en un commit de git → botón "deshacer".

## 3. Fases

| Fase | Entregable | Estado |
|---|---|---|
| 0 | Investigación + plan | ✅ |
| 1 | Orquestador + PWA + plantillas (audiolibros, web básica), probado en Linux | ✅ |
| 2 | Instalador Termux de un comando, prueba en Android real, puente Termux:API | pendiente |
| 3 | Remezclar desde URL de git / compartir proyecto (zip/QR), deshacer con git | pendiente |
| 4 | App Android propia (WebView + proot + Ubuntu Base) sin Termux, tienda de apps, login de Claude desde la app, accesos directos | ✅ v0.2 (probado en emulador x86_64) |
| 5 | Exportar a APK (Capacitor/TWA) y publicar apps a una URL pública (túnel) | pendiente |

## 3b. Web o nativa (decisión, oct. 2026)

- **Solo web (PWA) no basta**: un navegador no puede lanzar procesos, así que ni Linux ni Claude Code.
- **Termux + PWA** funciona, pero obliga a instalar Termux desde F-Droid y teclear comandos.
- **Elegido: APK nativo fino + Linux embebido + interfaz web en WebView.** El APK trae `proot`
  (compilado para Android por Termux), descarga Ubuntu Base la primera vez e instala Node.js y
  Claude Code. La interfaz sigue siendo HTML (la misma que en el PC) y lo nativo aporta lo que la
  web no puede: mantener vivo el Linux (servicio en primer plano), hardware sin Termux:API,
  iconos en la pantalla de inicio por app y abrir el login de Claude en el navegador.
- Ubuntu (glibc) y no Alpine (musl): musl usa la llamada `fork` en x86_64 y Android la bloquea a las apps.

## 4. Riesgos

- **Permisos del agente**: por defecto `acceptEdits` + lista blanca de comandos (npm, node, git…). Modo "libre" opcional.
- **Recursos del móvil**: batería y RAM; parar apps inactivas.
- **Android mata procesos en segundo plano**: servicio en primer plano + wake lock. En Android 12+ el
  límite de "procesos fantasma" puede matar a Claude; documentado cómo desactivarlo.
- **Google Play**: `targetSdk 28` impide publicarlo allí; distribución como APK directo.
- **Seguridad**: el panel escucha solo en 127.0.0.1; para red local exige token.
