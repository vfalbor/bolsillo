#!/bin/sh
# Bolsillo's internal monitor for Safari: every 15 s it writes to /var/log/bolsillo-monitor.log how Linux
# is doing (memory, load, the hungriest processes, Claude Code's state) and new kernel messages (out of
# memory, dying processes). Only shell and /proc so as not to load the emulator further.
# Read by the Debug tab and the server (GET /api/debug); the page sends it in its reports.
LOG=/var/log/bolsillo-monitor.log
INTERVAL=${1:-15}
: > "$LOG"
seen=0
n=0
log() { echo "$(date +%T) $*" >> "$LOG"; }

log "monitor running (every ${INTERVAL} s) · $(uname -r) · $(grep -c ^processor /proc/cpuinfo) CPU"
while :; do
  mem=$(awk '/^MemTotal/{t=$2} /^MemAvailable/{a=$2} END{printf "uses %d MB, %d of %d MB free", (t-a)/1024, a/1024, t/1024}' /proc/meminfo)
  load=$(cut -d' ' -f1-3 /proc/loadavg)
  # The 4 processes using the most memory: pid, name, MB, accumulated CPU seconds (the difference between
  # lines is what they used in that interval).
  # A single awk for all processes: in the emulator every process launched costs a lot.
  top=$(awk '{ i = index($0, "("); j = match($0, /\) [A-Z] /);
      name = substr($0, i + 1, j - i - 1); gsub(/ /, "_", name); split(substr($0, j + 2), f, " ");
      printf "%d %s %d %.0f\n", f[22] * 4 / 1024, name, $1, (f[12] + f[13]) / 100 }' /proc/[0-9]*/stat 2>/dev/null \
    | sort -rn | head -4 | while read -r mb name pid cpu; do
      # Node calls its threads "MainThread": say what it is (only for those, to avoid launching more processes).
      if [ "$name" = MainThread ]; then
        case "$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null)" in
          *claude*) name=claude ;; *server.js*) name=server ;; *) name=node ;;
        esac
      fi
      printf '%s[%s] %d MB %d s · ' "$name" "$pid" "$mb" "$cpu"
    done)
  # Claude is called "node …/cli.js" at startup and renames itself "claude" once running.
  claude=$( (pgrep -f '[c]laude-node/cli.js'; pgrep -x claude) | sort -u | tr '\n' ' ')
  log "mem: $mem · load $load · claude: ${claude:-no} · $top"
  # New kernel messages
  total=$(dmesg 2>/dev/null | wc -l)
  if [ "$total" -gt "$seen" ]; then
    dmesg 2>/dev/null | tail -n $((total - seen)) | grep -iE 'oom|out of memory|killed process|segfault|unhandled|traps:|i/o error|blk_update' | while read -r l; do log "kernel: $l"; done
    seen=$total
  fi
  n=$((n + 1))
  if [ $((n % 120)) -eq 0 ]; then tail -n 400 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
  sleep "$INTERVAL"
done
