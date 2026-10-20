# Linux aarch64 para container2wasm: Node 24 (Alpine) + bash, curl, git, ripgrep + Claude Code (JS sobre Node; el binario oficial como claude-bun) + Bolsillo.
# Sin RUN: el host es x86_64 y no ejecuta binarios arm64; todo se copia ya preparado.
FROM --platform=linux/arm64 node:24-alpine
COPY overlay/ /
COPY claude /usr/local/bin/claude-bun
COPY claude-node.sh /usr/local/bin/claude
COPY bolsillo/ /opt/bolsillo/
COPY start.sh /usr/local/bin/bolsillo-start
COPY diag.sh /usr/local/bin/bolsillo-diag
COPY monitor.sh /usr/local/bin/bolsillo-monitor
COPY chat.sh /usr/local/bin/bolsillo-chat
COPY open-url.sh /usr/local/bin/bolsillo-open
ENTRYPOINT ["/usr/local/bin/bolsillo-start"]
