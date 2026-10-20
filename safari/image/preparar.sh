#!/bin/sh
# Prepara la carpeta de la imagen de Safari con lo que no está en git: los paquetes de Alpine (apks/)
# desempaquetados en overlay/, Claude Code en JavaScript (npm) pasado a ASCII, la copia de Bolsillo
# y el binario oficial de Claude Code. Después: docker build y container2wasm (ver docs/PLAN-SAFARI.md).
#
#   sh safari/image/preparar.sh [ruta al binario oficial de Claude Code para linux-arm64-musl]
set -eu
cd "$(dirname "$0")"
CC_VERSION=2.1.112 # la última publicada en npm como JavaScript (ver claude-node.sh)

# 1. Paquetes de Alpine (bash, curl, git, ripgrep y sus bibliotecas), sin sus metadatos. busybox y musl
#    ya vienen en node:24-alpine.
for apk in apks/*.apk; do
  case "$apk" in apks/busybox-*|apks/musl-*) continue ;; esac
  tar xzf "$apk" -C overlay --exclude='.*' 2>/dev/null
done

# 2. Claude Code en JavaScript, en ASCII (en el emulador wasm Node falla con el UTF-8 del original).
tmp=$(mktemp -d)
(cd "$tmp" && npm pack --silent "@anthropic-ai/claude-code@$CC_VERSION" >/dev/null && tar xzf anthropic-ai-claude-code-*.tgz)
mkdir -p overlay/usr/local/lib/claude-node
cp -r "$tmp"/package/. overlay/usr/local/lib/claude-node/
# De vendor/ solo hace falta lo de arm64 Linux.
find overlay/usr/local/lib/claude-node/vendor -mindepth 2 -maxdepth 2 -type d ! -name arm64-linux ! -name arm64 -exec rm -rf {} +
rm -rf "$tmp"
node ../claude-ascii.mjs overlay/usr/local/lib/claude-node

# 3. Caché de compilación de Node para que Claude arranque antes (necesita poder ejecutar arm64: binfmt/qemu-user).
docker run --rm --platform linux/arm64 -v "$PWD/overlay/usr/local/lib:/l" -e NODE_COMPILE_CACHE=/l/claude-node-cc \
  node:24-alpine node /l/claude-node/cli.js --version || echo "sin caché de compilación (opcional)"

# 4. Bolsillo, el mismo de la raíz del repositorio.
rm -rf bolsillo && mkdir bolsillo
(cd ../.. && cp -r package.json server.js lib public templates safari/image/bolsillo/)

# 5. El binario oficial (se instala como claude-bun, solo para probarlo; ver Dockerfile).
if [ "${1-}" ]; then cp "$1" claude; fi
[ -f claude ] || { echo "Falta safari/image/claude: el binario oficial de Claude Code para linux-arm64-musl."; exit 1; }
echo "Listo: docker build --platform linux/arm64 -t bolsillo-safari:arm64 safari/image"
