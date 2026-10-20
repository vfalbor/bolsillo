#!/bin/sh
# Boot of Bolsillo's Linux inside Safari.
export HOME=/root USER=root LANG=C.UTF-8 TERM=xterm-256color PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/root/.local/bin
# Less memory and no self-rewriting code: what the emulator handles best.
# Bun only reads JavaScriptCore options with the BUN_JSC_ prefix (it ignores plain JSC_).
# No non-essential traffic (telemetry, error reports, updates) and no installing Anthropic's plugin
# marketplace on every boot (download and git): fewer connections and less CPU when Claude opens.
export BUN_JSC_useJIT=0 USE_BUILTIN_RIPGREP=0 DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1
# (~/.gitconfig and ~/bolsillo already come in the image: every program launched here costs seconds.)
# Internal monitor (memory, load, processes, Claude, kernel), readable from the server at /api/debug.
( setsid /usr/local/bin/bolsillo-monitor 30 > /dev/null 2>&1 & )
# The panel at lower priority: with a single CPU, Claude (what the person is waiting for) goes first.
( cd /opt/bolsillo && BOLSILLO_TTY=$(readlink /proc/$$/fd/0) BOLSILLO_DEBUG_LOGS=/var/log/bolsillo-monitor.log,/var/log/bolsillo-diag.log,/var/log/bolsillo.log BOLSILLO_DIAG_CMD=/usr/local/bin/bolsillo-diag CLAUDE_TIMEOUT_MS=600000 HOST=0.0.0.0 PORT=7700 BOLSILLO_TOKEN=${BOLSILLO_TOKEN:-safari} BOLSILLO_DATA=/root/bolsillo nice -n 10 node server.js > /var/log/bolsillo.log 2>&1 & )
echo
echo "  Bolsillo: Linux $(uname -m) inside the browser."
echo "  Claude Code opens by itself; when you leave it (/exit or Ctrl+C twice) you're at the terminal."
echo
cd /root
# The page's terminal size (it puts it on the kernel command line): without it Claude assumes 80 columns.
cols=$(sed -n 's/.*bolsillo\.cols=\([0-9]*\).*/\1/p' /proc/cmdline)
rows=$(sed -n 's/.*bolsillo\.rows=\([0-9]*\).*/\1/p' /proc/cmdline)
[ -n "$cols" ] && [ -n "$rows" ] && stty -F "$(readlink /proc/$$/fd/0)" cols "$cols" rows "$rows" 2>/dev/null
# An extra Ctrl+C when leaving Claude must not kill this script (it's what keeps Linux alive): it's caught
# here; programs launched from it get the normal Ctrl+C back.
trap ':' INT
# Chat mode (bolsillo.mode=chat on the kernel command line, set by the page): Claude without its interface
# and the chat drawn by the page. Otherwise, the usual terminal interface.
if grep -q 'bolsillo\.mode=chat' /proc/cmdline; then exec /usr/local/bin/bolsillo-chat; fi
claude
code=$?
echo
echo "  Claude Code has exited (code $code). Open it again with: claude"
exec /bin/bash -l
