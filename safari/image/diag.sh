#!/bin/sh
# Bolsillo self-check for Safari: launched from the debug view (POST /api/debug/diag), the result is read
# from /var/log/bolsillo-diag.log. It looks for why Claude Code fails in the browser's wasm emulator when
# the same disk works in native QEMU. Everything with short output: a syntax error in cli.js would print
# the whole line (13 MB).
exec > /var/log/bolsillo-diag.log 2>&1
CC=/usr/local/lib/claude-node
step() { echo; echo "== $1 ($(date +%T))"; }
short() { cut -c1-200 | head -n "${1:-8}"; }

step "system"
uname -a; free -m | head -2; grep -m1 Features /proc/cpuinfo

step "node: decode UTF-8 (Buffer, TextDecoder) and compare with the expected text"
node -e '
const cps = [0xf1, 0x20ac, 0x1f600, 0x627, 0x5d0, 0x4e2d, 0x41];
const want = String.fromCodePoint(...cps).repeat(4000);
const bytes = Buffer.from(want, "utf8");
const a = bytes.toString("utf8"), b = new TextDecoder().decode(bytes);
const firstBad = (s) => { for (let i = 0; i < want.length; i++) if (s[i] !== want[i]) return i; return s.length === want.length ? -1 : want.length; };
console.log("Buffer.toString:", a === want ? "OK" : "WRONG at " + firstBad(a));
console.log("TextDecoder:    ", b === want ? "OK" : "WRONG at " + firstBad(b));
console.log("Buffer.from:    ", Buffer.from(want).equals(bytes) ? "OK" : "WRONG");
' 2>&1 | short

step "node: read the original cli.js and check the round trip back to bytes is identical"
node -e '
const fs = require("fs"), raw = fs.readFileSync(process.argv[1]);
const s = raw.toString("utf8"), back = Buffer.from(s, "utf8");
console.log("bytes", raw.length, "chars", s.length, "round trip:", back.equals(raw) ? "OK" : "WRONG");
if (!back.equals(raw)) { let i = 0; while (i < raw.length && raw[i] === back[i]) i++; console.log("first difference at byte", i); }
' "$CC/cli-utf8.js" 2>&1 | short

step "node: compile the original cli.js (UTF-8)"
node --check "$CC/cli-utf8.js" > /tmp/chk 2>&1; echo "node exit: $?"; short 4 < /tmp/chk
step "node: compile the ASCII cli.js (the one claude uses)"
node --check "$CC/cli.js" > /tmp/chk 2>&1; echo "node exit: $?"; short 4 < /tmp/chk

step "claude --version (node, ASCII)"
timeout 300 claude --version 2>&1 | short 4

step "bun (claude-bun --help)"
timeout 300 claude-bun --help > /tmp/chk 2>&1; echo "bun exit: $?"; short 4 < /tmp/chk

step "end"
