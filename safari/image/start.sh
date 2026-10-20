#!/bin/sh
# Arranque del Linux de Bolsillo dentro de Safari.
export HOME=/root USER=root LANG=C.UTF-8 TERM=xterm-256color PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/root/.local/bin
# Menos memoria y nada de código que se reescribe: lo que mejor lleva el emulador.
# Bun solo lee las opciones de JavaScriptCore con el prefijo BUN_JSC_ (con JSC_ a secas las ignora).
# Sin tráfico no esencial (telemetría, informes de error, actualizaciones) ni instalar el marketplace de
# plugins de Anthropic en cada arranque (descarga y git): menos conexiones y CPU al abrir Claude.
export BUN_JSC_useJIT=0 USE_BUILTIN_RIPGREP=0 DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1
# (~/.gitconfig y ~/bolsillo ya vienen en la imagen: cada programa que se lanza aquí cuesta segundos.)
# Monitor interno (memoria, carga, procesos, Claude, kernel), legible desde el servidor por /api/debug.
( setsid /usr/local/bin/bolsillo-monitor 30 > /dev/null 2>&1 & )
# El panel con menos prioridad: con una sola CPU, Claude (lo que la persona espera) va primero.
( cd /opt/bolsillo && BOLSILLO_TTY=$(readlink /proc/$$/fd/0) BOLSILLO_DEBUG_LOGS=/var/log/bolsillo-monitor.log,/var/log/bolsillo-diag.log,/var/log/bolsillo.log BOLSILLO_DIAG_CMD=/usr/local/bin/bolsillo-diag CLAUDE_TIMEOUT_MS=600000 HOST=0.0.0.0 PORT=7700 BOLSILLO_TOKEN=${BOLSILLO_TOKEN:-safari} BOLSILLO_DATA=/root/bolsillo nice -n 10 node server.js > /var/log/bolsillo.log 2>&1 & )
echo
echo "  Bolsillo: Linux $(uname -m) dentro del navegador."
echo "  Claude Code se abre solo; al salir de él (/exit o Ctrl+C dos veces) quedas en la terminal."
echo
cd /root
# Prueba en el móvil: Claude Code arranca nada más cargar la página, para ver cómo se porta.
# Tamaño del terminal de la página (lo pone en la línea del kernel): sin él Claude supone 80 columnas.
cols=$(sed -n 's/.*bolsillo\.cols=\([0-9]*\).*/\1/p' /proc/cmdline)
rows=$(sed -n 's/.*bolsillo\.rows=\([0-9]*\).*/\1/p' /proc/cmdline)
[ -n "$cols" ] && [ -n "$rows" ] && stty -F "$(readlink /proc/$$/fd/0)" cols "$cols" rows "$rows" 2>/dev/null
# Un Ctrl+C de más al salir de Claude no debe matar este script (es el que mantiene vivo el Linux): se
# atrapa aquí; los programas que se lanzan vuelven a tener el Ctrl+C normal.
trap ':' INT
# Modo chat (bolsillo.mode=chat en la línea del kernel, lo pone la página): Claude sin interfaz y el
# chat dibujado por la página. Si no, la interfaz de terminal de siempre.
if grep -q 'bolsillo\.mode=chat' /proc/cmdline; then exec /usr/local/bin/bolsillo-chat; fi
claude
code=$?
echo
echo "  Claude Code ha terminado (código $code). Vuelve a abrirlo con: claude"
exec /bin/bash -l
