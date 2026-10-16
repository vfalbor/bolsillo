# Compatibilidad con versiones de Android

Pruebas del 16 oct. 2026 con `scripts/test-emulator.sh` (emuladores x86_64 con Google APIs, host
de 4 núcleos y 7 GB). Cada prueba parte de un emulador limpio y recorre el flujo entero: instalar
el APK → descargar Ubuntu → instalar Node.js y Claude Code → abrir el panel → crear una app de
plantilla y servirla → puente del móvil (batería, vibrar) → 30 s en segundo plano.

| Android | API | Kernel | Resultado | Tiempo hasta "Listo" |
|---|---|---|---|---|
| 8.0 | 26 | 3.18 | ⚠️ No compatible: la app avisa "móvil demasiado antiguo" | — |
| 9 | 28 | 4.4 | ✅ Todo OK (con `PROOT_NO_SECCOMP`) | 6 min |
| 11 | 30 | (no medido) | ✅ Todo OK | 13 min |
| 13 | 33 | (no medido) | ✅ Todo OK | 10 min |
| 14 | 34 | 6.1 | ✅ Todo OK | 6 min |
| 16 | 36 | 6.6 | ✅ Todo OK | 9 min |
| 17 | 37 | 6.12 | ❓ Sin verificar: el APK se instala, pero el emulador se cuelga en este host | — |
| 17, páginas de 16 KB | 37 | 6.12 | ❓ Sin verificar (mismo problema del emulador) | — |

Los tiempos son de emulador con red de servidor; en un móvil real dependen sobre todo de la conexión.

## Problemas encontrados y arreglados

- **proot se caía en kernels anteriores a 4.8** (`assertion "IS_IN_SYSENTER" failed` al lanzar
  `apt`): antes de Linux 4.8 seccomp detenía los procesos en otro orden. En esos kernels la app
  lanza proot con `PROOT_NO_SECCOMP=1` (más lento, pero funciona). Afecta a móviles con Android 8–9.
- **Kernel 3.x (Android 8 antiguos)**: Ubuntu 24.04 usa llamadas al sistema que no existen y proot
  no emula (`apt` falla en `realpath` con ENOSYS). Ahora la app lo detecta al arrancar y lo explica
  en vez de fallar a medias. Desde Android 9 Google exige kernel ≥ 4.4 en móviles nuevos.
- **Sin red al abrir la app** (recién encendido, cambio de red): antes fallaba al instante; ahora
  espera la conexión hasta 3 min y lo muestra ("Esperando conexión a internet…").
- **Descargas que se cortan**: Ubuntu se descarga con reintentos y reanuda donde se quedó; apt,
  curl y npm tienen reintentos.
- **Mensaje de error engañoso**: si la instalación de programas fallaba siempre decía "¿Hay
  conexión a internet?"; ahora muestra la última línea real del error.

## Revisión estática

- **Páginas de 16 KB** (móviles con Android 15+ que lo activan): todos los binarios de 64 bits del
  APK (proot, loader, libtalloc, libandroid-shmem) están alineados a 16 KB; Ubuntu arm64 y Node.js
  arm64 a 64 KB. Solo `libproot-loader32.so` está a 4 KB, y solo se usaría con programas de 32 bits,
  que Bolsillo no usa.
- **`targetSdk 28`**: se instala en Android 15–17 (el mínimo que exigen es 24). Las reglas de
  servicios en primer plano con tipo (Android 14) solo aplican a `targetSdk ≥ 34`.

## Notas para quien pruebe en emulador

- El usuario debe estar en el grupo `kvm`.
- Si el host usa systemd-resolved (`127.0.0.53`), los emuladores de Android 16+ se quedan sin DNS:
  el script les pasa un DNS real con `-dns-server`.
- En Android 16+ `ping` no responde desde el shell del emulador; no indica falta de red.
- Android 15+ recién arrancado sigue levantando servicios: el script reintenta la instalación y da
  3 GB de RAM. Android 17 necesita más máquina que este host (el *watchdog* del emulador lo mata);
  `BOLSILLO_EMU_GPU=guest` cambia el renderizador.

## Pendiente

- **Móvil real arm64** (lo que usará la gente): no se puede emular arm64 a velocidad útil en un
  PC x86_64. Opciones: un Android físico por USB (`adb install`), o una granja de dispositivos
  (Firebase Test Lab, AWS Device Farm).
- **Android 17** en un host con más RAM o en un móvil real.
- **Inicio de sesión real con Claude** en el móvil (el flujo está probado con un Claude simulado).
