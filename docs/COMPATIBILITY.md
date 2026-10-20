# Compatibility with Android versions

Tests from Oct 16, 2026 with `scripts/test-emulator.sh` (x86_64 emulators with Google APIs, a host
with 4 cores and 7 GB). Each test starts from a clean emulator and walks through the whole flow:
install the APK → download Ubuntu → install Node.js and Claude Code → open the panel → create a
template app and serve it → phone bridge (battery, vibrate) → 30 s in the background.

| Android | API | Kernel | Result | Time to "Ready" |
|---|---|---|---|---|
| 8.0 | 26 | 3.18 | ⚠️ Not supported: the app warns "phone too old" | — |
| 9 | 28 | 4.4 | ✅ All OK (with `PROOT_NO_SECCOMP`) | 6 min |
| 11 | 30 | (not measured) | ✅ All OK | 13 min |
| 13 | 33 | (not measured) | ✅ All OK | 10 min |
| 14 | 34 | 6.1 | ✅ All OK | 6 min |
| 16 | 36 | 6.6 | ✅ All OK | 9 min |
| 17 | 37 | 6.12 | ❓ Not verified: the APK installs, but the emulator hangs on this host | — |
| 17, 16 KB pages | 37 | 6.12 | ❓ Not verified (same emulator problem) | — |

Times are from an emulator on a server connection; on a real phone they depend mostly on the connection.

## Problems found and fixed

- **proot crashed on kernels older than 4.8** (`assertion "IS_IN_SYSENTER" failed` when launching
  `apt`): before Linux 4.8 seccomp stopped processes in a different order. On those kernels the app
  launches proot with `PROOT_NO_SECCOMP=1` (slower, but it works). Affects phones with Android 8–9.
- **Kernel 3.x (old Android 8 phones)**: Ubuntu 24.04 uses system calls that don't exist and proot
  doesn't emulate (`apt` fails in `realpath` with ENOSYS). The app now detects this at startup and
  explains it instead of half failing. Since Android 9 Google requires kernel ≥ 4.4 on new phones.
- **No network when opening the app** (just switched on, network change): it used to fail at once;
  now it waits up to 3 min for the connection and shows it ("Waiting for an internet connection…").
- **Downloads that get cut off**: Ubuntu is downloaded with retries and resumes where it stopped;
  apt, curl and npm have retries.
- **Misleading error message**: if installing packages failed it always said "Is there an internet
  connection?"; now it shows the actual last line of the error.

## Static review

- **16 KB pages** (phones with Android 15+ that turn them on): every 64-bit binary in the APK
  (proot, loader, libtalloc, libandroid-shmem) is 16 KB aligned; Ubuntu arm64 and Node.js arm64 are
  64 KB aligned. Only `libproot-loader32.so` is 4 KB aligned, and it would only be used with 32-bit
  programs, which Bolsillo doesn't use.
- **`targetSdk 28`**: installs on Android 15–17 (the minimum they require is 24). The typed
  foreground service rules (Android 14) only apply to `targetSdk ≥ 34`.

## Notes for whoever tests on an emulator

- The user must be in the `kvm` group.
- If the host uses systemd-resolved (`127.0.0.53`), Android 16+ emulators end up without DNS: the
  script passes them a real DNS with `-dns-server`.
- On Android 16+ `ping` doesn't answer from the emulator shell; it doesn't mean there's no network.
- Android 15+ right after boot is still starting services: the script retries the install and gives
  it 3 GB of RAM. Android 17 needs a bigger machine than this host (the emulator's *watchdog* kills
  it); `BOLSILLO_EMU_GPU=guest` changes the renderer.

## Pending

- **A real arm64 phone** (what people will use): arm64 can't be emulated at a useful speed on an
  x86_64 PC. Options: a physical Android over USB (`adb install`), or a device farm (Firebase Test
  Lab, AWS Device Farm).
- **Android 17** on a host with more RAM or on a real phone.
- **Real Claude sign-in** on the phone (the flow is tested with a simulated Claude).
