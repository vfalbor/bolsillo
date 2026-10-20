# Bolsillo en Safari: un Linux arm64 dentro del iPhone

Objetivo: que en un iPhone, solo con Safari, haya un "Linux" donde Claude Code se instale y se use
**igual que en un PC** (`curl … | bash` o `npm install -g @anthropic-ai/claude-code`, y luego
`claude`), y que ese mismo entorno sea la tienda de las apps que se creen. Revisado el 18 oct. 2026.

## 1. El hecho que manda: qué es hoy Claude Code

Comprobado descargando el paquete oficial (`@anthropic-ai/claude-code` 2.1.302):

- Desde la 2.1.1xx–2.1.200 ya no es JavaScript (`cli.js`): es un **ejecutable nativo** por
  plataforma, generado con `bun build --compile`. Lleva dentro **Bun 1.4.4** (con el motor
  JavaScriptCore) y el código de Claude Code.
- Versión Linux arm64 con musl: **265 MB**, ELF aarch64, solo depende de `libc.musl-aarch64.so.1`.
  Segmentos: ~82 MB de código, ~166 MB de datos.
- Admite opciones del motor por variables de entorno (`JSC_useJIT`, `BUN_JSC_*`).
- Licencia: "© Anthropic PBC. All rights reserved", sujeta a sus acuerdos legales.

Conclusión: para que la instalación sea **transparente** hay que ejecutar **ese binario oficial sin
tocarlo**. Eso solo se consigue haciendo que Safari se comporte como un **Linux aarch64**: emular
la CPU ARM64 y las llamadas al sistema de Linux. Es además la opción más limpia legalmente: se usa
el programa oficial, descargado por el instalador oficial, sin extraerlo ni modificarlo.

## 2. Cómo se hace: ARM64 → WebAssembly → CPU del iPhone

```
binario ARM64 de Claude Code
   │  traductor dinámico (JIT): bloques de instrucciones ARM64 → WebAssembly
   ▼
WebAssembly  ──(Safari lo compila con su JIT)──▼  instrucciones ARM64 nativas del iPhone
```

La CPU del iPhone acaba ejecutando el trabajo, pero pasando por dos traducciones. Es **emulación**
(más lenta que nativo), no virtualización: Safari no permite ejecutar código ARM directamente.

**Esto ya existe como base:** QEMU portado a WebAssembly (proyecto *qemu-wasm*, presentado en
FOSDEM 2025) con invitados AArch64 y un JIT (TCG) que genera WebAssembly, más *container2wasm*, que
convierte una imagen de contenedor en algo que arranca en el navegador. El JIT a WebAssembly aún no
está integrado en QEMU oficial (en QEMU oficial solo está el modo intérprete, 32 bits).

## 3. Dos arquitecturas posibles

| | **A. Máquina completa** (QEMU sistema) | **B. Solo procesos** (QEMU *linux-user* + núcleo propio) |
|---|---|---|
| Qué se emula | CPU + kernel Linux real + disco | CPU; las llamadas al sistema las atiende un núcleo nuestro en JS |
| Transparencia | Total: es un Linux de verdad (apk/apt, bash, git, curl, npm, instalador oficial) | Alta, pero hay que implementar las llamadas que usen los programas (~150) |
| Memoria | La RAM del invitado vive dentro de WebAssembly: kernel + caché + programas | Solo la de los procesos; mucho menos |
| Velocidad | Más lenta (MMU emulada) | Más rápida |
| Esfuerzo | **Bajo para el prototipo**: existe hoy | Alto: meses |

**Recomendación:** empezar por **A** (prototipo en días con lo que ya existe) para saber cuanto
antes si Claude Code arranca y responde en un iPhone; pasar a **B** solo si A no cabe en memoria o
es demasiado lenta.

## 4. Las cuatro piezas que lo hacen "como un Linux"

1. **CPU y sistema**: QEMU-wasm con un Alpine Linux aarch64 (musl, ligero; encaja con el binario
   musl de Claude Code). `uname -m` dice `aarch64`, así que npm y el instalador oficial eligen solos
   el binario correcto.
2. **Disco persistente**: el disco del Linux se guarda en el almacenamiento del navegador (OPFS),
   por bloques, para que lo instalado siga ahí al volver a abrir.
3. **Red**: un programa nativo abre conexiones TCP/TLS propias, y una web no puede. Solución
   limpia: un **relé WebSocket↔TCP** pequeño (en un servidor nuestro o del usuario) que solo pasa
   bytes; el TLS va de extremo a extremo dentro del Linux, así que el relé no ve el contenido. Es
   la única pieza fuera del iPhone.
4. **Puertos**: las apps que el usuario crea escuchan en puertos del Linux; un Service Worker las
   expone a Safari como páginas (`/app/<id>/`), que se pueden añadir a la pantalla de inicio. Encima
   va el panel de Bolsillo, que es la tienda.

## 5. Lo que puede fallar (y cómo se mide)

- **Memoria** (el riesgo número uno). WebAssembly de 32 bits tiene un techo de 4 GB y, en iPhone,
  Safari en la práctica da entre ~200 MB y ~1 GB por página y mata la pestaña al pasarse; no he
  podido confirmar que Safari ya tenga memoria de 64 bits (Memory64). Claude Code necesita sus
  ~265 MB más la memoria de su motor de JavaScript más el propio Linux. Ayudas posibles: arrancar
  Bun con el JIT de JavaScriptCore desactivado (`JSC_useJIT=0`: menos memoria y nada de código que
  se reescribe a sí mismo, que es lo que peor lleva un emulador), reservas de memoria más pequeñas,
  y Alpine mínimo. Hay que medirlo.
- **Velocidad**: dos traducciones encadenadas, y JavaScriptCore en modo intérprete. El arranque de
  Claude Code puede tardar mucho; luego casi todo el tiempo es esperar a la API, que no depende de
  la CPU. Hay que medirlo.
- **iOS congela Safari** al cambiar de app o bloquear la pantalla: el Linux se pausa (no se pierde
  si el disco está en OPFS, pero el turno se corta). El "Modo de aislamiento" de iOS desactiva el
  JIT de WebAssembly y lo haría inutilizable.
- **El JIT a WebAssembly de QEMU no es oficial** todavía: dependemos de una rama.
- **Licencia y uso**: se ejecuta el binario oficial sin modificar; aun así, conviene confirmar con
  Anthropic que es aceptable y si la suscripción Pro/Max vale en este entorno.

## 6. Plan por fases

| Fase | Entregable | Duración orientativa | Puerta |
|---|---|---|---|
| **0. Prototipo A en PC** | Imagen Alpine aarch64 + Claude Code oficial, convertida con container2wasm; arranca en un navegador de escritorio y `claude --version` responde | 1 semana | Si no arranca ni en escritorio, pasar a evaluar B |
| **1. Prototipo A en iPhone** | La misma imagen en Safari del iPhone; medir memoria, tiempo de arranque, tiempo de `claude --version` y de una pregunta real; probar `JSC_useJIT=0` | 1–2 semanas | **Decisión clave**: si cabe y responde en un tiempo aceptable, seguir con A; si no, B |
| **2. Red y disco** | Relé WebSocket↔TCP, disco persistente en OPFS, instalación con el instalador oficial dentro del iPhone | 2–3 semanas | `curl … \| bash` y `claude` funcionan tras cerrar y reabrir Safari |
| **3. Bolsillo dentro** | Node + `server.js` de Bolsillo en el Linux; Service Worker que expone los puertos; el panel como PWA | 3–4 semanas | Pedir una app desde el iPhone y abrirla desde la pantalla de inicio |
| **4. Tienda** | Catálogo, instalar/abrir, compartir y remezclar por enlace o QR, exportar una app como web independiente | 3–4 semanas | Una app hecha en un iPhone se instala en otro |
| **5. Optimizar** (o **B** si la fase 1 lo pide) | Menos memoria y más velocidad; si toca B: núcleo propio + QEMU linux-user | 1–2 meses (B: 3–5) | — |

Las fases 0 y 1 responden a la pregunta que importa (¿corre el Claude Code oficial en un iPhone?)
en unas 2–3 semanas, antes de invertir en el resto.

## 7. Alternativa de respaldo

Si la emulación no cabe en un iPhone: el modo "pantalla remota" (Bolsillo en un PC o servidor y el
iPhone como panel, ya posible hoy) o un agente propio en JavaScript sobre la API de Claude, que
correría a velocidad nativa en Safari pero no sería Claude Code.

## 8. Medidas reales (18 oct. 2026, WebKit 26 y Chromium en Linux, `safari/test-vm.mjs`)

Prototipo A: QEMU-wasm (container2wasm 0.8.4) con Alpine aarch64, Node 24, Claude Code 2.1.302 y Bolsillo.

| Configuración | WebKit (motor de Safari) | Chromium |
|---|---|---|
| Original: precarga entera (660 MB) + 1024 MB de RAM + instantánea | 2766 MB solo al arrancar el módulo | — |
| Disco bajo demanda, 256 MB de RAM, sin UEFI | >1500 MB (muere) | 957 MB estable, pero el kernel no arranca sin UEFI |
| Disco bajo demanda, 256 MB de RAM, con UEFI, arranque en frío | — | pico 1232 MB; el kernel arranca y el disco baja 25 MB en 13 peticiones |
| Ídem con 448 MB de RAM y búfer JIT de 64 MB | — | sube sin parar y pasa de 1500 MB a los 71 s |
| Ídem con búfer JIT de 16 MB | — | sube más despacio (1123 → 1486 MB en 90 s) y pasa de 1500 MB a los 99 s |

Cómo se reparte, cuadrado con las dos primeras filas (la diferencia medida, 1388 MB, coincide con la
esperada, 1391 MB):

- **RAM del Linux**: se reserva **entera** al arrancar (Emscripten pone a cero la memoria que pide QEMU).
  Cada MB de `-m` es un MB de la pestaña.
- **Disco** (`rootfs.bin`, 467 MB): con `web/lazy-load.js` ya no ocupa la pestaña; se baja por trozos de
  1 MB solo lo que se lee, con un tope de caché (48 MB por defecto).
- **Instantánea** (`vm.state`, 92 MB) y **firmware UEFI** (64 MB): solo hacen falta para arrancar en
  segundos; en frío la instantánea sobra. Sin UEFI este kernel no arranca.
- **Base del propio QEMU-wasm**: ~1,1 GB en WebKit (~0,6 GB en Chromium), que crece mientras el Linux
  ejecuta código nuevo. Es lo que más pesa y no depende del Linux: la wasm de QEMU (58 MB) compilada por
  el motor más los miles de módulos pequeños que genera su JIT (TCG→wasm). La diferencia entre WebKit y
  Chromium (unos +500 MB) es del motor. qemu-wasm crea un `WebAssembly.Module` y una `Instance` por
  cada bloque caliente (`instantiate_wasm` en `out.js`) y solo los suelta cuando vacía su caché **y**
  pasa el recolector de basura del navegador, que no ve esa memoria; por eso no se estabiliza.

Conclusión: en un iPhone el mínimo realista es **~1,5–1,8 GB** por pestaña. Si Safari del iPhone deja
eso o no es justo lo que mide la prueba de la fase 1; el WebKit de Linux no tiene los límites de iOS.
Recortar la base exige recompilar QEMU-wasm (menos dispositivos y un umbral más alto para pasar
bloques del intérprete al JIT), que es trabajo de la fase 5.

## 9. Bolsillo como sistema operativo embebido

Objetivo (18 oct.): que Bolsillo sea un **SO completo e independiente** dentro del navegador. Las apps de la
tienda pueden instalar lo que necesiten (por ejemplo una base de datos) y Claude Code corre en el mismo
sistema.

### Lo que ya da la arquitectura A

Es un Linux de verdad (kernel, Alpine, musl, `apk`), así que todo lo que corre en un Alpine arm64 corre aquí sin
portarlo: SQLite, PostgreSQL, MariaDB, Redis, Node, Python, servicios en segundo plano y puertos
locales. Una app que pide «PostgreSQL» hace `apk add postgresql` exactamente igual que en un servidor.
Con la arquitectura B (solo procesos) cada base de datos sería un proyecto de compatibilidad aparte: es
otra razón para quedarse con A.

### Lo que falta para que sea un SO (por orden)

1. **Disco persistente y escribible.** Hoy el disco base es de solo lectura y lo escrito vive en la RAM
   del Linux (overlay en tmpfs): se pierde al cerrar y cada MB instalado es un MB de memoria. Diseño:
   - *disco base* (sistema, Claude Code): de solo lectura, servido por trozos y cacheable en una CDN;
     se actualiza cambiando de versión;
   - *disco de usuario* (segundo disco virtio, ext4, p. ej. 4 GB disperso): guardado en **OPFS** por
     bloques. Encima, un overlayfs hace que todo el sistema parezca escribible (`/usr`, `/var/lib`,
     `/root`); `apk add` y los datos de las bases de datos acaban aquí.
   - Técnica: OPFS síncrono solo existe en Workers. Hay dos caminos. Uno es recompilar QEMU-wasm con
     WASMFS y su backend OPFS (el correcto). El otro, sin recompilar, es que el hilo principal guarde en
     OPFS en segundo plano los trozos que el Linux escribe, sobre `lazy-load.js`, que ya separa los
     trozos escritos. Ese segundo camino arriesga perder los últimos segundos si iOS mata la pestaña.
     Las bases de datos lo aguantan (journaling o WAL) si el orden de escritura se respeta.
2. **Servicios del sistema.** Un supervisor (OpenRC o s6, ya en Alpine) arranca las bases de datos y
   las apps instaladas en cada arranque, con un puerto fijo por app.
3. **Formato de app de la tienda.** `bolsillo.json` amplía lo que ya existe: dependencias del sistema
   (`"system": ["postgresql16"]`), servicios que necesita (`"services": {"db": "postgresql"}`), puerto y
   datos. Al instalar: `apk add` de las dependencias, una base de datos y un usuario propios en el
   servicio compartido (no un PostgreSQL por app: no hay memoria para eso) y el alta del servicio. Al
   desinstalar se borra todo, base de datos incluida. Exportar o importar app y datos va a un fichero
   (Archivos de iOS).
4. **Apps visibles en Safari sin servidor.** Hoy `/p/<puerto>/` pasa por la puerta del servidor. Para
   ser independiente: un **Service Worker** que entregue cada petición `/p/<puerto>/…` a la pila de red
   del propio navegador, hacia el puerto del Linux, sin salir del iPhone. container2wasm ya tiene la
   pieza: la pila TCP/IP en wasm de `c2w-net-proxy`.
5. **Independencia de red, con sus límites.** Safari no puede abrir TCP, y ningún diseño lo cambia:
   - *Sin red* funciona todo lo local: apps, bases de datos, servicios y la comunicación entre ellos.
   - *API de Claude* sin servidor intermedio: la API de Anthropic admite llamadas desde el navegador
     (CORS). Se apunta `ANTHROPIC_BASE_URL` a un puerto local del Linux que el navegador reenvía con
     `fetch`. Con clave de API funciona; con la suscripción Pro/Max (OAuth) hay que comprobarlo.
   - *Instalar paquetes* (`apk`, `npm`, `git clone`): los repositorios públicos no admiten CORS. Hace falta
     el relé WebSocket↔TCP (lo que hay ahora) o un **espejo propio con CORS** de los paquetes que use la
     tienda: ficheros estáticos en cualquier CDN, sin servidor propio en marcha.
6. **Límites de iOS que afectan a un SO.** Safari congela la pestaña en segundo plano, así que los
   servicios se paran (no hay servidores 24/7 en el iPhone). Safari borra los datos de las webs que no
   se abren en 7 días, salvo si se **añade a la pantalla de inicio**, cosa obligatoria para no perder el
   disco. El Modo de aislamiento quita el JIT y lo hace inutilizable. Y la cuota de OPFS es amplia
   pero finita.

### Presupuesto de memoria de un SO útil

Base de QEMU-wasm (1,1 GB en WebKit) + RAM del Linux: kernel y sistema ~60 MB, Claude Code ~250–350 MB
mientras trabaja, PostgreSQL ~40–80 MB, Node con el panel ~60 MB y cada app ~30–80 MB. Con 512–768 MB
de RAM caben Claude Code, una base de datos y un par de apps: **~1,7–2 GB por pestaña**. La prueba en el
iPhone dice si eso cabe; si no cabe, queda la opción C.

### Alternativa C: CheerpX (WebVM)

Máquina virtual x86 en wasm de Leaning Technologies, madura, con disco persistente en IndexedDB y sin
reservar RAM de invitado por adelantado (emula procesos sobre un núcleo propio, como la B). Claude Code
tiene binario Linux x64 musl. Gasta mucha menos memoria que QEMU-wasm, pero su licencia es gratuita solo
para uso personal o no comercial (la comercial es de pago), su red pasa por Tailscale (también un relé) y
hay que comprobar que el JIT de Bun funciona encima. Merece una prueba de un día si la fase 1 falla por
memoria.

### Recomendación

1. Mañana: la prueba en el iPhone (`/vm/probar.html`) decide entre seguir con A o mirar C.
2. Si A cabe: disco de usuario persistente en OPFS, después servicios y formato de app con
   dependencias del sistema (la base de datos como primer caso), después el Service Worker para las
   apps y la API de Claude sin relé.
3. El relé y el espejo de paquetes quedan como las únicas piezas externas, ambas sin estado.
