#!/bin/sh
# Claude Code in Safari: the JavaScript version (2.1.112, the last one published that way) on Node.
# The official binary (Bun/JavaScriptCore) gives "Segmentation fault" in the browser's wasm emulator,
# although the same disk works in native QEMU. It stays installed as claude-bun to try it.
CC=/usr/local/lib/claude-node
MON=/var/log/bolsillo-monitor.log

# Quick questions without starting 13 MB of JavaScript (minutes in the emulator): the panel asks them at
# startup and they competed for the single CPU with the Claude the person opens.
case "$*" in
  --version|-v)
    echo "$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$CC/package.json") (Claude Code)"; exit 0 ;;
  "auth status --json")
    if [ -s "$HOME/.claude/.credentials.json" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai"}'
    else echo '{"loggedIn":false}'; fi
    exit 0 ;;
esac

# Everything else really runs, and the monitor records how it starts and ends. If Node crashes, it leaves
# its report in /var/log/claude-reports.
mkdir -p /var/log/claude-reports
start=$(date +%s)
[ -w "$MON" ] && echo "$(date +%T) claude starts: $* (pid $$, node ${CLAUDE_NODE_FLAGS---jitless})" >> "$MON"
# --jitless: V8 only interprets and generates no new machine code. In the browser's wasm emulator every
# piece of new code has to be translated to WebAssembly again (the most expensive thing there is), so
# without JIT the emulator reuses what it has already translated. Can be changed with CLAUDE_NODE_FLAGS.
# The compile cache comes prebuilt in the image (a Claude start in native QEMU with the same options):
# Node skips compiling cli.js, ~20% faster startup.
export NODE_COMPILE_CACHE="${NODE_COMPILE_CACHE-/usr/local/lib/claude-node-cc}"
NODE_OPTIONS="${NODE_OPTIONS} ${CLAUDE_NODE_FLAGS---jitless} --report-on-fatalerror --report-uncaught-exception --report-on-signal --report-directory=/var/log/claude-reports" \
  node "$CC/${CLAUDE_ENTRY:-cli.js}" "$@"
code=$?
if [ -w "$MON" ]; then
  sig=""; [ $code -gt 128 ] && sig=" (signal $((code - 128)))"
  echo "$(date +%T) claude exits: code $code$sig after $(( $(date +%s) - start )) s" >> "$MON"
  ls -t /var/log/claude-reports 2>/dev/null | head -1 | sed 's/^/  node report: /' >> "$MON"
fi
exit $code
