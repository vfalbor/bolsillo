#!/bin/sh
# Autodiagnóstico de Bolsillo en Safari: lo lanza la vista de depuración (POST /api/debug/diag) y el
# resultado se lee en /var/log/bolsillo-diag.log. Busca por qué Claude Code falla en el emulador wasm
# del navegador cuando el mismo disco funciona en QEMU nativo. Todo con salida corta: un error de
# sintaxis en cli.js imprimiría la línea entera (13 MB).
exec > /var/log/bolsillo-diag.log 2>&1
CC=/usr/local/lib/claude-node
step() { echo; echo "== $1 ($(date +%T))"; }
short() { cut -c1-200 | head -n "${1:-8}"; }

step "sistema"
uname -a; free -m | head -2; grep -m1 Features /proc/cpuinfo

step "node: descodificar UTF-8 (Buffer, TextDecoder) y comparar con lo esperado"
node -e '
const cps = [0xf1, 0x20ac, 0x1f600, 0x627, 0x5d0, 0x4e2d, 0x41];
const want = String.fromCodePoint(...cps).repeat(4000);
const bytes = Buffer.from(want, "utf8");
const a = bytes.toString("utf8"), b = new TextDecoder().decode(bytes);
const firstBad = (s) => { for (let i = 0; i < want.length; i++) if (s[i] !== want[i]) return i; return s.length === want.length ? -1 : want.length; };
console.log("Buffer.toString:", a === want ? "OK" : "MAL en " + firstBad(a));
console.log("TextDecoder:    ", b === want ? "OK" : "MAL en " + firstBad(b));
console.log("Buffer.from:    ", Buffer.from(want).equals(bytes) ? "OK" : "MAL");
' 2>&1 | short

step "node: leer cli.js original y comprobar que la vuelta a bytes es idéntica"
node -e '
const fs = require("fs"), raw = fs.readFileSync(process.argv[1]);
const s = raw.toString("utf8"), back = Buffer.from(s, "utf8");
console.log("bytes", raw.length, "chars", s.length, "ida y vuelta:", back.equals(raw) ? "OK" : "MAL");
if (!back.equals(raw)) { let i = 0; while (i < raw.length && raw[i] === back[i]) i++; console.log("primera diferencia en el byte", i); }
' "$CC/cli-utf8.js" 2>&1 | short

step "node: compilar cli.js original (UTF-8)"
node --check "$CC/cli-utf8.js" > /tmp/chk 2>&1; echo "salida de node: $?"; short 4 < /tmp/chk
step "node: compilar cli.js en ASCII (el que usa claude)"
node --check "$CC/cli.js" > /tmp/chk 2>&1; echo "salida de node: $?"; short 4 < /tmp/chk

step "claude --version (node, ASCII)"
timeout 300 claude --version 2>&1 | short 4

step "bun (claude-bun --help)"
timeout 300 claude-bun --help > /tmp/chk 2>&1; echo "salida de bun: $?"; short 4 < /tmp/chk

step "fin"
