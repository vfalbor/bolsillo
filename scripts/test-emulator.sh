#!/usr/bin/env bash
# Pruebas de compatibilidad: arranca un emulador de una versión de Android, instala el APK y
# recorre el flujo completo (Linux, Node, Claude Code, crear y abrir una app, puente del móvil).
#
#   scripts/test-emulator.sh <imagen> [apk]
#   ej.: scripts/test-emulator.sh "system-images;android-30;google_apis;x86_64"
#
# Escribe el informe y una captura en test/emulator-results/<api>/ y una línea en summary.tsv.
# Si tu usuario aún no tiene el grupo kvm activo en esta sesión, se usa `sg kvm`.
set -uo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
image="$1"
apk="${2:-$here/android/app/build/outputs/apk/release/bolsillo-0.2.0.apk}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}" JAVA_HOME="${JAVA_HOME:-$HOME/tools/jdk}"
adb="$ANDROID_HOME/platform-tools/adb"
tag=$(echo "$image" | cut -d';' -f2,3 | tr ';' '-')
avd="bolsillo-$tag"
port=5580
serial="emulator-$port"
out="$here/test/emulator-results/$tag"
mkdir -p "$out"
report="$out/report.txt"
: > "$report"
say() { echo "$*" | tee -a "$report"; }
A() { "$adb" -s "$serial" "$@"; }
fail() { say "✗ $*"; finish FALLA; }
finish() {
  timeout 20 "$adb" -s "$serial" exec-out screencap -p > "$out/screen.png" 2>/dev/null
  timeout 20 "$adb" -s "$serial" logcat -d -s Bolsillo:I AndroidRuntime:E > "$out/logcat.txt" 2>/dev/null
  printf '%s\t%s\t%s\t%ss\t%s\n' "$tag" "$release" "$1" "$SECONDS" "$(tail -1 "$report")" >> "$here/test/emulator-results/summary.tsv"
  timeout 20 "$adb" -s "$serial" emu kill >/dev/null 2>&1 || kill "$emu_pid" 2>/dev/null
  wait "$emu_pid" 2>/dev/null
  exit 0
}

if ! "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" list avd -c | grep -qx "$avd"; then
  echo no | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" -s create avd -n "$avd" -k "$image" -d pixel_6 >/dev/null || { echo "No pude crear $avd"; exit 1; }
  sed -i 's/^hw.ramSize=.*/hw.ramSize=2560/; s/^disk.dataPartition.size=.*/disk.dataPartition.size=8G/' "$HOME/.android/avd/$avd.avd/config.ini"
  grep -q '^hw.ramSize' "$HOME/.android/avd/$avd.avd/config.ini" || echo hw.ramSize=2560 >> "$HOME/.android/avd/$avd.avd/config.ini"
fi

api=$(echo "$image" | sed -n 's/.*android-\([0-9]*\).*/\1/p')
mem=2560; [ "$api" -ge 35 ] && mem=3072
# Si el host usa systemd-resolved (127.0.0.53), los emuladores nuevos se quedan sin DNS: darles uno real.
dns=$(resolvectl dns 2>/dev/null | awk '/^Link/ && NF>3 {print $4; exit}'); dns=${dns:-8.8.8.8}
emu="$ANDROID_HOME/emulator/emulator -avd $avd -port $port -no-window -no-audio -no-snapshot -no-boot-anim -gpu ${BOLSILLO_EMU_GPU:-swiftshader_indirect} -wipe-data -memory $mem -cores 2 -dns-server $dns,8.8.8.8"
if id -nG | grep -qw kvm; then $emu > "$out/emulator.log" 2>&1 &
else sg kvm -c "$emu" > "$out/emulator.log" 2>&1 &
fi
emu_pid=$!
release="?"
SECONDS=0

say "== $image"
A wait-for-device
until [ "$(A shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; do
  [ $SECONDS -gt 600 ] && fail "el emulador no arrancó en 10 min"
  sleep 3
done
release=$(A shell getprop ro.build.version.release | tr -d '\r')
say "Android $release (API $(A shell getprop ro.build.version.sdk | tr -d '\r')), arranque en ${SECONDS}s"
A shell settings put global window_animation_scale 0 >/dev/null 2>&1
# Android 17 en un host modesto: el emulador se cuelga si además corren los servicios de Google.
if [ "$api" -ge 37 ]; then
  for pkg in com.google.android.gms com.google.android.gms.persistent com.google.android.googlequicksearchbox \
             com.android.vending com.google.android.apps.wellbeing com.google.android.as com.google.android.youtube \
             com.google.android.apps.photos com.google.android.apps.maps com.google.android.gm com.android.chrome; do
    timeout 30 "$adb" -s "$serial" shell pm disable-user --user 0 $pkg >/dev/null 2>&1
  done
  say "  (servicios de Google desactivados para aligerar el emulador; esperando 2 min a que se asiente)"
  sleep 120
fi
say "  kernel $(A shell uname -r | tr -d '\r')"
# Dar tiempo a que la red del emulador arranque. En Android 16+ ping no responde desde el shell,
# así que solo es un aviso: la app espera la conexión por su cuenta.
t=$SECONDS
until A shell ping -c1 -W2 cdimage.ubuntu.com >/dev/null 2>&1; do
  [ $((SECONDS-t)) -gt 90 ] && { say "  (ping sin respuesta; sigo, la app espera la red)"; break; }
  sleep 3
done

t=$SECONDS
# Recién arrancado, Android 15+ sigue levantando servicios y el instalador puede caerse: reintentar.
for i in 1 2 3 4 5 6; do
  inst=$(A install -r -g "$apk" 2>&1 | grep -E 'Success|Failure|failed' | tail -1)
  [ "$inst" = "Success" ] && break
  sleep 30
done
[ "$inst" = "Success" ] || fail "instalar el APK: $inst"
say "✓ APK instalado"
A shell am start -W -n app.bolsillo/.MainActivity >/dev/null || fail "no se abrió la app"
sleep 4
# Android 14+ avisa de que la app es para una versión antigua: aceptar el aviso si aparece.
A exec-out screencap -p > "$out/first-screen.png" 2>/dev/null
if A shell dumpsys window 2>/dev/null | grep -qiE 'mCurrentFocus.*(DeprecatedTargetSdk|UnsupportedCompileSdk|AlertDialog|Application Error)'; then
  say "! diálogo del sistema al abrir: $(A shell dumpsys window | grep -m1 mCurrentFocus | tr -d '\r')"
  A shell input keyevent KEYCODE_ENTER
fi

# Esperar a que Linux esté listo (descarga Ubuntu + apt + Node + Claude Code).
t=$SECONDS
last=""
while :; do
  log=$(A logcat -d -s Bolsillo:I 2>/dev/null)
  cur=$(echo "$log" | grep -E '» ' | tail -1 | sed 's/.*Bolsillo: //' | tr -d '\r')
  [ "$cur" != "$last" ] && { echo "   $cur  (+$((SECONDS-t))s)" | tee -a "$report"; last="$cur"; }
  echo "$log" | grep -q '» Listo$' && echo "$log" | grep -q 'Arrancando Bolsillo' && \
    { A forward tcp:17700 tcp:7700 >/dev/null; curl -fs -m 3 http://127.0.0.1:17700/api/info >/dev/null && break; }
  echo "$log" | grep -q 'Algo falló' && { echo "$log" | tail -15 >> "$report"; fail "la preparación de Linux falló"; }
  [ $((SECONDS-t)) -gt 2400 ] && fail "Linux no quedó listo en 40 min"
  sleep 10
done
say "✓ Linux + panel listos en $((SECONDS-t))s"

api() { curl -fsS -m 120 -H 'content-type: application/json' -X "$1" "http://127.0.0.1:17700$2" ${3:+-d "$3"}; }
say "  info: $(api GET /api/info | head -c 300)"
v=$(api POST /api/shell '{"cmd":"node -v; claude --version; git --version; uname -m"}') || fail "/api/shell"
say "  versiones: $(echo "$v" | tr '\n' ' ' | head -c 300)"
echo "$v" | grep -q 'Claude Code' || fail "claude no responde dentro de Linux"
say "✓ Node y Claude Code funcionan"
say "  claude: $(api GET /api/claude | head -c 200)"

p=$(api POST /api/projects '{"name":"Prueba Emulador","template":"temporizador"}') || fail "crear proyecto"
id=$(echo "$p" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
r=$(api POST "/api/projects/$id/run") || fail "arrancar la app"
aport=$(echo "$r" | sed -n 's/.*"port":\([0-9]*\).*/\1/p')
sleep 3
A forward tcp:17800 tcp:"$aport" >/dev/null
curl -fs -m 10 http://127.0.0.1:17800/ | grep -qi '<html' || fail "la app creada no responde en el puerto $aport"
say "✓ app de plantilla creada y servida (puerto $aport)"
api POST "/api/projects/$id/stop" >/dev/null; api DELETE "/api/projects/$id" >/dev/null

caps=$(api GET /api/device) || fail "/api/device"
say "  capacidades: $(echo "$caps" | head -c 200)"
bat=$(api POST /api/device/battery '{}') || fail "puente: batería"
say "✓ puente del móvil (batería): $(echo "$bat" | head -c 120)"
api POST /api/device/vibrate '{"ms":100}' >/dev/null && say "✓ puente del móvil (vibrar)"
A shell am start -n app.bolsillo/.MainActivity >/dev/null; sleep 3

# ¿Sobrevive Linux con la app en segundo plano?
A shell input keyevent KEYCODE_HOME; sleep 30
curl -fs -m 5 http://127.0.0.1:17700/api/info >/dev/null && say "✓ sigue vivo 30 s en segundo plano" || say "✗ murió en segundo plano"
A shell am start -n app.bolsillo/.MainActivity >/dev/null; sleep 5
say "OK"
finish OK
