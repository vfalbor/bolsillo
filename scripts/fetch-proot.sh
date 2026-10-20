#!/usr/bin/env bash
# Downloads proot (and the two libraries it needs) built for Android by Termux, and puts
# them in android/app/src/main/jniLibs/<abi>/ named lib*.so so Android installs them as
# executable files in the app's native library folder.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
out="$here/android/app/src/main/jniLibs"
repo="https://packages.termux.dev/apt/termux-main"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fetch() { # arch package -> extracted dir
  local arch=$1 pkg=$2 file
  [ -f "$work/Packages-$arch" ] || curl -fsSL "$repo/dists/stable/main/binary-$arch/Packages.gz" | gzip -dc > "$work/Packages-$arch"
  file=$(awk -v p="$pkg" '$1=="Package:"{cur=$2} cur==p && $1=="Filename:"{print $2; exit}' "$work/Packages-$arch")
  [ -n "$file" ] || { echo "Can't find $pkg for $arch" >&2; exit 1; }
  mkdir -p "$work/$arch/$pkg"
  curl -fsSL -o "$work/$arch/$pkg.deb" "$repo/$file"
  (cd "$work/$arch/$pkg" && ar x "../$pkg.deb" && tar xf data.tar.*)
  echo "$work/$arch/$pkg/data/data/com.termux/files/usr"
}

for pair in aarch64:arm64-v8a x86_64:x86_64; do
  arch=${pair%%:*} abi=${pair##*:}
  mkdir -p "$out/$abi"
  proot=$(fetch "$arch" proot)
  talloc=$(fetch "$arch" libtalloc)
  shmem=$(fetch "$arch" libandroid-shmem)
  cp "$proot/bin/proot" "$out/$abi/libproot.so"
  cp "$proot/libexec/proot/loader" "$out/$abi/libproot-loader.so"
  [ -f "$proot/libexec/proot/loader32" ] && cp "$proot/libexec/proot/loader32" "$out/$abi/libproot-loader32.so"
  cp "$(ls "$talloc"/lib/libtalloc.so.2* | head -1)" "$out/$abi/libtalloc.so"
  cp "$shmem/lib/libandroid-shmem.so" "$out/$abi/libandroid-shmem.so"
  echo "✓ $abi: $(ls "$out/$abi" | tr '\n' ' ')"
done
