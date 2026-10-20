# aarch64 Linux for container2wasm: Node 24 (Alpine) + bash, curl, git, ripgrep + Claude Code (JS on Node; the official binary as claude-bun) + Bolsillo.
# No RUN: the host is x86_64 and does not run arm64 binaries; everything is copied in ready-made.
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
