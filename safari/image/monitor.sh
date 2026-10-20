#!/bin/sh
# Monitor interno de Bolsillo en Safari: cada 15 s apunta en /var/log/bolsillo-monitor.log cómo está el
# Linux (memoria, carga, procesos que más gastan, estado de Claude Code) y los mensajes nuevos del
# kernel (falta de memoria, procesos que mueren). Es solo shell y /proc para no cargar más al emulador.
# Lo leen la pestaña Debug y el servidor (GET /api/debug); la página lo manda en sus informes.
LOG=/var/log/bolsillo-monitor.log
INTERVAL=${1:-15}
: > "$LOG"
seen=0
n=0
log() { echo "$(date +%T) $*" >> "$LOG"; }

log "monitor en marcha (cada ${INTERVAL} s) · $(uname -r) · $(grep -c ^processor /proc/cpuinfo) CPU"
while :; do
  mem=$(awk '/^MemTotal/{t=$2} /^MemAvailable/{a=$2} END{printf "usa %d MB, libres %d de %d MB", (t-a)/1024, a/1024, t/1024}' /proc/meminfo)
  load=$(cut -d' ' -f1-3 /proc/loadavg)
  # Los 4 procesos con más memoria: pid, nombre, MB, segundos de CPU acumulados (el avance entre
  # líneas es lo que han gastado en esos 5 s).
  # Un solo awk para todos los procesos: en el emulador cada proceso que se lanza cuesta mucho.
  top=$(awk '{ i = index($0, "("); j = match($0, /\) [A-Z] /);
      name = substr($0, i + 1, j - i - 1); gsub(/ /, "_", name); split(substr($0, j + 2), f, " ");
      printf "%d %s %d %.0f\n", f[22] * 4 / 1024, name, $1, (f[12] + f[13]) / 100 }' /proc/[0-9]*/stat 2>/dev/null \
    | sort -rn | head -4 | while read -r mb name pid cpu; do
      # Node llama «MainThread» a sus hilos: se pone qué es (solo para esos, para no lanzar más procesos).
      if [ "$name" = MainThread ]; then
        case "$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null)" in
          *claude*) name=claude ;; *server.js*) name=servidor ;; *) name=node ;;
        esac
      fi
      printf '%s[%s] %d MB %d s · ' "$name" "$pid" "$mb" "$cpu"
    done)
  # Claude se llama «node …/cli.js» al arrancar y se renombra «claude» cuando ya está en marcha.
  claude=$( (pgrep -f '[c]laude-node/cli.js'; pgrep -x claude) | sort -u | tr '\n' ' ')
  log "mem: $mem · carga $load · claude: ${claude:-no} · $top"
  # Mensajes nuevos del kernel
  total=$(dmesg 2>/dev/null | wc -l)
  if [ "$total" -gt "$seen" ]; then
    dmesg 2>/dev/null | tail -n $((total - seen)) | grep -iE 'oom|out of memory|killed process|segfault|unhandled|traps:|i/o error|blk_update' | while read -r l; do log "kernel: $l"; done
    seen=$total
  fi
  n=$((n + 1))
  if [ $((n % 120)) -eq 0 ]; then tail -n 400 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
  sleep "$INTERVAL"
done
