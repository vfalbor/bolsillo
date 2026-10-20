#!/bin/sh
# Bolsillo chat mode for Safari: Claude Code without its terminal interface (which inside the emulator
# redraws the whole screen on every key and runs in slow motion). The page draws the chat with Safari's
# native JavaScript and talks to this script over the terminal, one line per message:
#
#   Linux → page     @@BOLSILLO chat ready@@
#   page → Linux     @@HELLO <seconds>                   back from a snapshot: the time, and another "chat ready"
#   page → Linux     @@DATA <url>                        apps backup on the server (see restore_and_sync)
#   page → Linux     @@TOKEN <sk-ant-oat…|sk-ant-api…>   token saved on the iPhone
#                    @@TOKEN -                           no session (or signed out)
#   Linux → page     @@BOLSILLO claude starting@@ and then the JSON lines of claude --output-format stream-json
#   page → Linux     JSON lines for claude --input-format stream-json: messages ({"type":"user",…}) and
#                    {"type":"control_request",…,"subtype":"initialize"}, which Claude answers as soon as it
#                    has loaded (that's how the page knows it's ready)
#   Linux → page     @@BOLSILLO claude exited <code>@@ (and it is reopened)
#
# This script is the only one reading the terminal (raw and without echo: the token never goes back to the
# screen) and it routes: the token to a file Claude picks up (preload.mjs), messages to Claude's input.
tty=$(readlink /proc/$$/fd/0)
stty -F "$tty" raw -echo 2>/dev/null
say() { printf '\n@@BOLSILLO %s@@\n' "$*"; }
mkdir -p /run/bolsillo
TOKEN_FILE=/run/bolsillo/token
IN=/run/bolsillo/claude-in
rm -f "$IN"; mkfifo "$IN"
exec 3<>"$IN" # held open here so Claude never sees the end of its input

claude_running=0
start_claude() {
  [ "$claude_running" = 1 ] && return
  claude_running=1
  # The VM is disposable and lives inside the tab: Claude works without asking permission for each
  # tool (there's no terminal to ask in). IS_SANDBOX lets it do so as root.
  (
    cd /root/bolsillo 2>/dev/null || cd /root
    while :; do
      say "claude starting"
      IS_SANDBOX=1 CLAUDE_ENTRY=preload.mjs BOLSILLO_TOKEN_FILE="$TOKEN_FILE" \
        claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages \
        --permission-mode bypassPermissions < "$IN" 2>> /var/log/claude-chat.log
      say "claude exited $?"
      sleep 2
    done
  ) &
}

# Apps backup on the server (the page sends @@DATA <url> before the token): restored at boot and uploaded
# again when something changes, at most every 30 s. Without node_modules (they get reinstalled).
DATA=/root/bolsillo
restore_and_sync() {
  url=$1
  mkdir -p "$DATA/projects"
  if curl -fsS --max-time 120 "$url" -o /run/bolsillo/data.tgz 2>/dev/null; then
    tar xzf /run/bolsillo/data.tgz -C "$DATA" && say "data restored $(ls "$DATA/projects" | wc -l)"
  else say "data new"; fi
  rm -f /run/bolsillo/data.tgz
  touch /run/bolsillo/saved
  while sleep 30; do
    [ -n "$(find "$DATA/projects" -newer /run/bolsillo/saved -not -path '*/node_modules*' 2>/dev/null | head -1)" ] || continue
    touch /run/bolsillo/saving
    if tar czf - -C "$DATA" --exclude node_modules projects 2>/dev/null | curl -fsS --max-time 300 -X PUT --data-binary @- "$url" >/dev/null 2>&1; then
      mv /run/bolsillo/saving /run/bolsillo/saved; say "data saved"
    fi
  done
}

say "chat ready"
while IFS= read -r line; do
  line=$(printf '%s' "$line" | tr -d '\r')
  case "$line" in
    "@@SNAPSHOT")
      # Only when making the snapshot (make-snapshot.py): drop the disk cache, which with init_on_free=1 is
      # left as zeros and takes no room in the snapshot (the disk is read from the network again if needed).
      sync; echo 3 > /proc/sys/vm/drop_caches 2>/dev/null
      say "snapshot ready $(grep -c ' 9p ' /proc/mounts)" ;;
    "@@HELLO "*)
      # The page boots from a snapshot (Linux and Claude already loaded): the clock stayed at the snapshot's
      # time, so set it, and say again that we're ready.
      date -s "@${line#@@HELLO }" >/dev/null 2>&1
      say "chat ready" ;;
    "@@DATA "*)
      restore_and_sync "${line#@@DATA }" & ;;
    "@@TOKEN -")
      # No session (or signed out): if Claude is already open, it forgets the one it had.
      [ "$claude_running" = 1 ] && printf -- '-\n' > "$TOKEN_FILE"
      start_claude ;;
    "@@TOKEN "*)
      (umask 077; printf '%s\n' "${line#@@TOKEN }" > "$TOKEN_FILE")
      start_claude ;;
    "{"*)
      printf '%s\n' "$line" >&3 ;;
  esac
done
