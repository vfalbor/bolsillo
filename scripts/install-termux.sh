#!/data/data/com.termux/files/usr/bin/bash
# Installs Bolsillo on Android. Run it inside Termux (installed from F-Droid or GitHub):
#   curl -fsSL <URL-of-this-script> | bash
# Uses an Ubuntu in proot to run the official Claude Code installer without patches.
set -euo pipefail

REPO="${BOLSILLO_REPO:-https://github.com/vfalbor/bolsillo.git}"
DISTRO=ubuntu

say() { printf '\n\033[1;33m▸ %s\033[0m\n' "$*"; }

say "Updating Termux and installing proot-distro and Termux:API"
pkg update -y && pkg upgrade -y
pkg install -y proot-distro termux-api

if ! proot-distro list 2>/dev/null | grep -q "^  *$DISTRO.*installed"; then
  say "Installing Ubuntu (≈2 GB, takes a few minutes)"
  proot-distro install "$DISTRO" || true
fi

say "Preparing Ubuntu: Node.js, git and Claude Code"
proot-distro login "$DISTRO" --shared-tmp -- bash -lc "
  set -e
  export DEBIAN_FRONTEND=noninteractive
  apt update && apt upgrade -y        # without up-to-date SSL the Claude installer returns 403
  apt install -y nodejs git curl ca-certificates
  if ! command -v claude >/dev/null && [ ! -x ~/.local/bin/claude ]; then
    curl -fsSL https://claude.ai/install.sh | bash
  fi
  grep -q '.local/bin' ~/.bashrc || echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc
  if [ -d ~/bolsillo/.git ]; then git -C ~/bolsillo pull --ff-only; else git clone '$REPO' ~/bolsillo; fi
"

say "Creating the 'bolsillo' command"
cat > "$PREFIX/bin/bolsillo" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
# Keeps the phone awake while you work and opens the panel in the browser.
termux-wake-lock
( sleep 3; termux-open-url http://127.0.0.1:7700/ ) &
proot-distro login $DISTRO --shared-tmp -- bash -lc '
  export PATH="\$HOME/.local/bin:\$PATH:/data/data/com.termux/files/usr/bin"
  cd ~/bolsillo && node server.js
'
termux-wake-unlock
EOF
chmod +x "$PREFIX/bin/bolsillo"

cat <<'EOF'

  ✅ Done.

  1. Sign in to Claude Code once:
       proot-distro login ubuntu -- bash -lc claude
     (the browser opens to sign in with your Claude account; then type /exit)

  2. Start Bolsillo whenever you want with:
       bolsillo

  3. In the browser: menu ⋮ → "Add to Home screen" to have it as an app.

  Also install the "Termux:API" app (F-Droid) so your apps can use voice, notifications,
  flashlight, location…
EOF
