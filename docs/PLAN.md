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
| 1 | Orquestador + PWA + plantillas (audiolibros, web básica), probado en Linux | 🚧 en curso |
| 2 | Instalador Termux de un comando, prueba en Android real, puente Termux:API | pendiente |
| 3 | Remezclar desde URL de git / compartir proyecto (zip/QR), deshacer con git | pendiente |
| 4 | App Android propia (WebView + Termux embebido o proot) para no tener que instalar Termux | pendiente |
| 5 | Exportar a APK (Capacitor/TWA) y publicar apps a una URL pública (túnel) | pendiente |

## 4. Riesgos

- **Permisos del agente**: por defecto `acceptEdits` + lista blanca de comandos (npm, node, git…). Modo "libre" opcional.
- **Recursos del móvil**: batería y RAM; parar apps inactivas.
- **Android mata procesos en segundo plano**: `termux-wake-lock` mientras se trabaja.
- **Seguridad**: el panel escucha solo en 127.0.0.1; para red local exige token.
