#!/bin/sh
# Claude Code en Safari: la versión en JavaScript (2.1.112, la última publicada así) sobre Node.
# El binario oficial (Bun/JavaScriptCore) da «Segmentation fault» en el emulador wasm del navegador,
# aunque el mismo disco funciona en QEMU nativo. Sigue instalado como claude-bun para probarlo.
CC=/usr/local/lib/claude-node
MON=/var/log/bolsillo-monitor.log

# Preguntas rápidas sin arrancar los 13 MB de JavaScript (en el emulador tardan minutos): el panel las
# hace al arrancar y competían por la única CPU con el Claude que abre la persona.
case "$*" in
  --version|-v)
    echo "$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$CC/package.json") (Claude Code)"; exit 0 ;;
  "auth status --json")
    if [ -s "$HOME/.claude/.credentials.json" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai"}'
    else echo '{"loggedIn":false}'; fi
    exit 0 ;;
esac

# El resto se ejecuta de verdad, y queda apuntado en el monitor cómo empieza y cómo acaba. Si Node
# falla, deja su informe en /var/log/claude-reports.
mkdir -p /var/log/claude-reports
start=$(date +%s)
[ -w "$MON" ] && echo "$(date +%T) claude empieza: $* (pid $$, node ${CLAUDE_NODE_FLAGS---jitless})" >> "$MON"
# --jitless: V8 solo interpreta y no genera código máquina nuevo. En el emulador wasm del navegador cada
# trozo de código nuevo hay que traducirlo otra vez a WebAssembly (lo más caro que hay), así que sin JIT
# el emulador reutiliza lo ya traducido. Se puede cambiar con CLAUDE_NODE_FLAGS.
# La caché de compilación viene hecha en la imagen (un arranque de Claude en QEMU nativo con las mismas
# opciones): Node se ahorra compilar cli.js, ~20 % menos de arranque.
export NODE_COMPILE_CACHE="${NODE_COMPILE_CACHE-/usr/local/lib/claude-node-cc}"
NODE_OPTIONS="${NODE_OPTIONS} ${CLAUDE_NODE_FLAGS---jitless} --report-on-fatalerror --report-uncaught-exception --report-on-signal --report-directory=/var/log/claude-reports" \
  node "$CC/${CLAUDE_ENTRY:-cli.js}" "$@"
code=$?
if [ -w "$MON" ]; then
  sig=""; [ $code -gt 128 ] && sig=" (señal $((code - 128)))"
  echo "$(date +%T) claude termina: código $code$sig tras $(( $(date +%s) - start )) s" >> "$MON"
  ls -t /var/log/claude-reports 2>/dev/null | head -1 | sed 's/^/  informe de node: /' >> "$MON"
fi
exit $code
