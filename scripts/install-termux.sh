#!/data/data/com.termux/files/usr/bin/bash
# Instala Bolsillo en Android. Ejecútalo dentro de Termux (instalado desde F-Droid o GitHub):
#   curl -fsSL <URL-de-este-script> | bash
# Usa un Ubuntu en proot para correr el instalador oficial de Claude Code sin parches.
set -euo pipefail

REPO="${BOLSILLO_REPO:-https://github.com/vfalbor/bolsillo.git}"
DISTRO=ubuntu

say() { printf '\n\033[1;33m▸ %s\033[0m\n' "$*"; }

say "Actualizando Termux e instalando proot-distro y Termux:API"
pkg update -y && pkg upgrade -y
pkg install -y proot-distro termux-api

if ! proot-distro list 2>/dev/null | grep -q "^  *$DISTRO.*installed"; then
  say "Instalando Ubuntu (≈2 GB, tarda unos minutos)"
  proot-distro install "$DISTRO" || true
fi

say "Preparando Ubuntu: Node.js, git y Claude Code"
proot-distro login "$DISTRO" --shared-tmp -- bash -lc "
  set -e
  export DEBIAN_FRONTEND=noninteractive
  apt update && apt upgrade -y        # sin SSL al día el instalador de Claude devuelve 403
  apt install -y nodejs git curl ca-certificates
  if ! command -v claude >/dev/null && [ ! -x ~/.local/bin/claude ]; then
    curl -fsSL https://claude.ai/install.sh | bash
  fi
  grep -q '.local/bin' ~/.bashrc || echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc
  if [ -d ~/bolsillo/.git ]; then git -C ~/bolsillo pull --ff-only; else git clone '$REPO' ~/bolsillo; fi
"

say "Creando el comando 'bolsillo'"
cat > "$PREFIX/bin/bolsillo" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
# Mantiene el móvil despierto mientras trabajas y abre el panel en el navegador.
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

  ✅ Listo.

  1. Inicia sesión en Claude Code una vez:
       proot-distro login ubuntu -- bash -lc claude
     (se abrirá el navegador para entrar con tu cuenta de Claude; luego escribe /exit)

  2. Arranca Bolsillo cuando quieras con:
       bolsillo

  3. En el navegador: menú ⋮ → "Añadir a pantalla de inicio" para tenerlo como una app.

  Instala también la app "Termux:API" (F-Droid) para que tus apps usen voz, notificaciones,
  linterna, ubicación…
EOF
