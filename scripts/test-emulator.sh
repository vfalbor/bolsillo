#!/usr/bin/env bash
# Compatibility tests: boots an emulator of an Android version, installs the APK and walks through
# the whole flow (Linux, Node, Claude Code, creating and opening an app, phone bridge).
#
#   scripts/test-emulator.sh <image> [apk]
#   e.g.: scripts/test-emulator.sh "system-images;android-30;google_apis;x86_64"
#
# Writes the report and a screenshot to test/emulator-results/<api>/ and a line to summary.tsv.
# If your user doesn't have the kvm group active in this session yet, `sg kvm` is used.
set -uo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
image="$1"
apk="${2:-$here/android/app/build/outputs/apk/release/bolsillo-0.3.0.apk}"
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
fail() { say "✗ $*"; finish FAIL; }
finish() {
  timeout 20 "$adb" -s "$serial" exec-out screencap -p > "$out/screen.png" 2>/dev/null
  timeout 20 "$adb" -s "$serial" logcat -d -s Bolsillo:I AndroidRuntime:E > "$out/logcat.txt" 2>/dev/null
  printf '%s\t%s\t%s\t%ss\t%s\n' "$tag" "$release" "$1" "$SECONDS" "$(tail -1 "$report")" >> "$here/test/emulator-results/summary.tsv"
  timeout 20 "$adb" -s "$serial" emu kill >/dev/null 2>&1 || kill "$emu_pid" 2>/dev/null
  wait "$emu_pid" 2>/dev/null
  exit 0
}

if ! "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" list avd -c | grep -qx "$avd"; then
  echo no | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" -s create avd -n "$avd" -k "$image" -d pixel_6 >/dev/null || { echo "Couldn't create $avd"; exit 1; }
  sed -i 's/^hw.ramSize=.*/hw.ramSize=2560/; s/^disk.dataPartition.size=.*/disk.dataPartition.size=8G/' "$HOME/.android/avd/$avd.avd/config.ini"
  grep -q '^hw.ramSize' "$HOME/.android/avd/$avd.avd/config.ini" || echo hw.ramSize=2560 >> "$HOME/.android/avd/$avd.avd/config.ini"
fi

api=$(echo "$image" | sed -n 's/.*android-\([0-9]*\).*/\1/p')
mem=2560; [ "$api" -ge 35 ] && mem=3072
# If the host uses systemd-resolved (127.0.0.53), new emulators end up without DNS: give them a real one.
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
  [ $SECONDS -gt 600 ] && fail "the emulator didn't boot in 10 min"
  sleep 3
done
release=$(A shell getprop ro.build.version.release | tr -d '\r')
say "Android $release (API $(A shell getprop ro.build.version.sdk | tr -d '\r')), booted in ${SECONDS}s"
A shell settings put global window_animation_scale 0 >/dev/null 2>&1
# Android 17 on a modest host: the emulator hangs if Google services run too.
if [ "$api" -ge 37 ]; then
  for pkg in com.google.android.gms com.google.android.gms.persistent com.google.android.googlequicksearchbox \
             com.android.vending com.google.android.apps.wellbeing com.google.android.as com.google.android.youtube \
             com.google.android.apps.photos com.google.android.apps.maps com.google.android.gm com.android.chrome; do
    timeout 30 "$adb" -s "$serial" shell pm disable-user --user 0 $pkg >/dev/null 2>&1
  done
  say "  (Google services disabled to lighten the emulator; waiting 2 min for it to settle)"
  sleep 120
fi
say "  kernel $(A shell uname -r | tr -d '\r')"
# Give the emulator's network time to come up. On Android 16+ ping doesn't answer from the shell,
# so it's only a warning: the app waits for the connection on its own.
t=$SECONDS
until A shell ping -c1 -W2 cdimage.ubuntu.com >/dev/null 2>&1; do
  [ $((SECONDS-t)) -gt 90 ] && { say "  (no ping answer; going on, the app waits for the network)"; break; }
  sleep 3
done

t=$SECONDS
# Right after boot, Android 15+ is still starting services and the installer can fail: retry.
for i in 1 2 3 4 5 6; do
  inst=$(A install -r -g "$apk" 2>&1 | grep -E 'Success|Failure|failed' | tail -1)
  [ "$inst" = "Success" ] && break
  sleep 30
done
[ "$inst" = "Success" ] || fail "installing the APK: $inst"
say "✓ APK installed"
A shell am start -W -n app.bolsillo/.MainActivity >/dev/null || fail "the app didn't open"
sleep 4
# Android 14+ warns that the app targets an old version: accept the warning if it shows up.
A exec-out screencap -p > "$out/first-screen.png" 2>/dev/null
if A shell dumpsys window 2>/dev/null | grep -qiE 'mCurrentFocus.*(DeprecatedTargetSdk|UnsupportedCompileSdk|AlertDialog|Application Error)'; then
  say "! system dialog on open: $(A shell dumpsys window | grep -m1 mCurrentFocus | tr -d '\r')"
  A shell input keyevent KEYCODE_ENTER
fi

# Wait for Linux to be ready (Ubuntu download + apt + Node + Claude Code).
t=$SECONDS
last=""
while :; do
  log=$(A logcat -d -s Bolsillo:I 2>/dev/null)
  cur=$(echo "$log" | grep -E '» ' | tail -1 | sed 's/.*Bolsillo: //' | tr -d '\r')
  [ "$cur" != "$last" ] && { echo "   $cur  (+$((SECONDS-t))s)" | tee -a "$report"; last="$cur"; }
  echo "$log" | grep -q '» Done$' && echo "$log" | grep -q 'Starting Bolsillo' && \
    { A forward tcp:17700 tcp:7700 >/dev/null; curl -fs -m 3 http://127.0.0.1:17700/api/info >/dev/null && break; }
  echo "$log" | grep -q 'Something went wrong' && { echo "$log" | tail -15 >> "$report"; fail "preparing Linux failed"; }
  [ $((SECONDS-t)) -gt 2400 ] && fail "Linux wasn't ready in 40 min"
  sleep 10
done
say "✓ Linux + panel ready in $((SECONDS-t))s"

api() { curl -fsS -m 120 -H 'content-type: application/json' -X "$1" "http://127.0.0.1:17700$2" ${3:+-d "$3"}; }
say "  info: $(api GET /api/info | head -c 300)"
v=$(api POST /api/shell '{"cmd":"node -v; claude --version; git --version; uname -m"}') || fail "/api/shell"
say "  versions: $(echo "$v" | tr '\n' ' ' | head -c 300)"
echo "$v" | grep -q 'Claude Code' || fail "claude doesn't answer inside Linux"
say "✓ Node and Claude Code work"
say "  claude: $(api GET /api/claude | head -c 200)"

p=$(api POST /api/projects '{"name":"Emulator Test","template":"kitchen-timer"}') || fail "create project"
id=$(echo "$p" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
r=$(api POST "/api/projects/$id/run") || fail "start the app"
aport=$(echo "$r" | sed -n 's/.*"port":\([0-9]*\).*/\1/p')
sleep 3
A forward tcp:17800 tcp:"$aport" >/dev/null
curl -fs -m 10 http://127.0.0.1:17800/ | grep -qi '<html' || fail "the created app doesn't answer on port $aport"
say "✓ template app created and served (port $aport)"
api POST "/api/projects/$id/stop" >/dev/null; api DELETE "/api/projects/$id" >/dev/null

caps=$(api GET /api/device) || fail "/api/device"
say "  capabilities: $(echo "$caps" | head -c 200)"
bat=$(api POST /api/device/battery '{}') || fail "bridge: battery"
say "✓ phone bridge (battery): $(echo "$bat" | head -c 120)"
api POST /api/device/vibrate '{"ms":100}' >/dev/null && say "✓ phone bridge (vibrate)"
A shell am start -n app.bolsillo/.MainActivity >/dev/null; sleep 3

# Does Linux survive with the app in the background?
A shell input keyevent KEYCODE_HOME; sleep 30
curl -fs -m 5 http://127.0.0.1:17700/api/info >/dev/null && say "✓ still alive after 30 s in the background" || say "✗ died in the background"
A shell am start -n app.bolsillo/.MainActivity >/dev/null; sleep 5
say "OK"
finish OK
