#!/bin/sh
# Fills the Safari image folder with what isn't in git: the Alpine packages (apks/) unpacked into overlay/,
# Claude Code in JavaScript (npm) converted to ASCII, the copy of Bolsillo and the official Claude Code
# binary. Then: docker build and container2wasm (see safari/README.md).
#
#   sh safari/image/prepare.sh [path to the official Claude Code binary for linux-arm64-musl]
set -eu
cd "$(dirname "$0")"
CC_VERSION=2.1.112 # the last one published on npm as JavaScript (see claude-node.sh)

# 1. Alpine packages (bash, curl, git, ripgrep and their libraries), without their metadata. busybox and
#    musl already come with node:24-alpine.
for apk in apks/*.apk; do
  case "$apk" in apks/busybox-*|apks/musl-*) continue ;; esac
  tar xzf "$apk" -C overlay --exclude='.*' 2>/dev/null
done

# 2. Claude Code in JavaScript, as ASCII (in the wasm emulator Node fails on the original's UTF-8).
tmp=$(mktemp -d)
(cd "$tmp" && npm pack --silent "@anthropic-ai/claude-code@$CC_VERSION" >/dev/null && tar xzf anthropic-ai-claude-code-*.tgz)
mkdir -p overlay/usr/local/lib/claude-node
cp -r "$tmp"/package/. overlay/usr/local/lib/claude-node/
# Only the arm64 Linux parts of vendor/ are needed.
find overlay/usr/local/lib/claude-node/vendor -mindepth 2 -maxdepth 2 -type d ! -name arm64-linux ! -name arm64 -exec rm -rf {} +
rm -rf "$tmp"
node ../claude-ascii.mjs overlay/usr/local/lib/claude-node

# 3. Node compile cache so Claude starts faster (needs to be able to run arm64: binfmt/qemu-user).
docker run --rm --platform linux/arm64 -v "$PWD/overlay/usr/local/lib:/l" -e NODE_COMPILE_CACHE=/l/claude-node-cc \
  node:24-alpine node /l/claude-node/cli.js --version || echo "no compile cache (optional)"

# 4. Bolsillo, the same as at the root of the repository.
rm -rf bolsillo && mkdir bolsillo
(cd ../.. && cp -r package.json server.js lib public templates safari/image/bolsillo/)

# 5. The official binary (installed as claude-bun, only to try it; see Dockerfile).
if [ "${1-}" ]; then cp "$1" claude; fi
[ -f claude ] || { echo "Missing safari/image/claude: the official Claude Code binary for linux-arm64-musl."; exit 1; }
echo "Done: docker build --platform linux/arm64 -t bolsillo-safari:arm64 safari/image"
