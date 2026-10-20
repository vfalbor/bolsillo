#!/bin/sh
# Modo chat de Bolsillo en Safari: Claude Code sin su interfaz de terminal (que dentro del emulador
# redibuja toda la pantalla con cada tecla y va a cámara lenta). La página dibuja el chat con el
# JavaScript nativo de Safari y habla con este script por el terminal, una línea por mensaje:
#
#   Linux → página   @@BOLSILLO chat listo@@
#   página → Linux   @@HOLA <segundos>                   al volver de una instantánea: hora y otro «chat listo»
#   página → Linux   @@DATOS <url>                       copia de las apps en el servidor (ver restore_and_sync)
#   página → Linux   @@TOKEN <sk-ant-oat…|sk-ant-api…>   token guardado en el iPhone
#                    @@TOKEN login                       iniciar sesión con la suscripción (Pro/Max)
#                    @@TOKEN -                           sin sesión
#   con «login»      @@BOLSILLO login empieza@@, @@BOLSILLO abrir <enlace>@@ (Claude Code lo «abre» con
#                    $BROWSER), la salida de «claude setup-token» (al final, el token) y
#                    @@BOLSILLO login termina <código>@@; la página manda entonces @@TOKEN <token>
#   Linux → página   @@BOLSILLO claude arranca@@ y luego las líneas JSON de claude --output-format stream-json
#   página → Linux   líneas JSON de claude --input-format stream-json: mensajes ({"type":"user",…}) y
#                    {"type":"control_request",…,"subtype":"initialize"}, que Claude contesta en cuanto ha
#                    cargado (así la página sabe cuándo está listo)
#   Linux → página   @@BOLSILLO claude termina <código>@@ (y se vuelve a abrir)
#
# Este script es el único que lee el terminal (en crudo y sin eco: el token no vuelve a la pantalla) y
# reparte: el token a un fichero que recoge Claude (preload.mjs), los mensajes a la entrada de Claude.
tty=$(readlink /proc/$$/fd/0)
stty -F "$tty" raw -echo 2>/dev/null
say() { printf '\n@@BOLSILLO %s@@\n' "$*"; }
mkdir -p /run/bolsillo
TOKEN_FILE=/run/bolsillo/token
IN=/run/bolsillo/claude-in
rm -f "$IN"; mkfifo "$IN"
exec 3<>"$IN" # abierto aquí para que Claude nunca vea el final de su entrada

claude_running=0
start_claude() {
  [ "$claude_running" = 1 ] && return
  claude_running=1
  # La VM es desechable y vive dentro de la pestaña: Claude trabaja sin pedir permiso para cada
  # herramienta (no hay terminal donde preguntar). IS_SANDBOX le deja hacerlo como root.
  (
    cd /root/bolsillo 2>/dev/null || cd /root
    while :; do
      say "claude arranca"
      IS_SANDBOX=1 CLAUDE_ENTRY=preload.mjs BOLSILLO_TOKEN_FILE="$TOKEN_FILE" \
        claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages \
        --permission-mode bypassPermissions < "$IN" 2>> /var/log/claude-chat.log
      say "claude termina $?"
      sleep 2
    done
  ) &
}

# Copia de las apps en el servidor (la página manda @@DATOS <url> antes que el token): se recupera al
# arrancar y se vuelve a subir cuando algo cambia, cada 30 s como mucho. Sin node_modules (se reinstala).
DATA=/root/bolsillo
restore_and_sync() {
  url=$1
  mkdir -p "$DATA/projects"
  if curl -fsS --max-time 120 "$url" -o /run/bolsillo/datos.tgz 2>/dev/null; then
    tar xzf /run/bolsillo/datos.tgz -C "$DATA" && say "datos recuperados $(ls "$DATA/projects" | wc -l)"
  else say "datos nuevos"; fi
  rm -f /run/bolsillo/datos.tgz
  touch /run/bolsillo/guardado
  while sleep 30; do
    [ -n "$(find "$DATA/projects" -newer /run/bolsillo/guardado -not -path '*/node_modules*' 2>/dev/null | head -1)" ] || continue
    touch /run/bolsillo/guardando
    if tar czf - -C "$DATA" --exclude node_modules projects 2>/dev/null | curl -fsS --max-time 300 -X PUT --data-binary @- "$url" >/dev/null 2>&1; then
      mv /run/bolsillo/guardando /run/bolsillo/guardado; say "datos guardados"
    fi
  done
}

say "chat listo"
while IFS= read -r line; do
  line=$(printf '%s' "$line" | tr -d '\r')
  case "$line" in
    "@@FOTO")
      # Solo al hacer la instantánea (make-snapshot.py): vacía la caché de disco, que con init_on_free=1 queda a
      # ceros y no ocupa en la instantánea (el disco se vuelve a leer de la red si hace falta).
      sync; echo 3 > /proc/sys/vm/drop_caches 2>/dev/null
      say "foto lista $(grep -c ' 9p ' /proc/mounts)" ;;
    "@@HOLA "*)
      # La página arranca desde una instantánea (Linux y Claude ya cargados): el reloj se quedó en la hora
      # de la instantánea, se pone en hora, y se vuelve a avisar de que está listo.
      date -s "@${line#@@HOLA }" >/dev/null 2>&1
      say "chat listo" ;;
    "@@DATOS "*)
      restore_and_sync "${line#@@DATOS }" & ;;
    "@@TOKEN login")
      # Inicio de sesión oficial de Claude Code: «abre» el enlace de claude.ai con $BROWSER (que se lo pasa
      # a la página), espera el código que da claude.ai y escribe un token de un año.
      say "login empieza"
      BROWSER=/usr/local/bin/bolsillo-open BOLSILLO_TTY="$tty" timeout 1800 claude setup-token
      code=$?
      stty -F "$tty" raw -echo 2>/dev/null
      say "login termina $code"
      say "chat listo" ;;
    "@@TOKEN -")
      # Sin sesión (o se ha cerrado): si Claude ya está abierto, olvida la que tuviera.
      [ "$claude_running" = 1 ] && printf -- '-\n' > "$TOKEN_FILE"
      start_claude ;;
    "@@TOKEN "*)
      (umask 077; printf '%s\n' "${line#@@TOKEN }" > "$TOKEN_FILE")
      start_claude ;;
    "{"*)
      printf '%s\n' "$line" >&3 ;;
  esac
done
