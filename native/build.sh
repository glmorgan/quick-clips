#!/bin/bash
#
# Builds the native picker window host into the plugin's bin/ directory.
#
# Produces a universal binary so the packaged plugin runs on both Apple Silicon and Intel.
# Output lands in *.sdPlugin/bin/, which is gitignored (like plugin.js) and included by
# `streamdeck pack`.
#
# Requires only the Command Line Tools — no full Xcode.
#
# NOTE: the resulting binary is unsigned. That is fine for local development, where a plugin
# you built yourself is not quarantined. Distributing it needs a Developer ID certificate and
# notarization, or macOS Gatekeeper will refuse to run it on someone else's machine.
#
set -euo pipefail

cd "$(dirname "$0")/.."

SRC="native/picker-host.swift"
OUT_DIR="com.quickclips.streamdeck.sdPlugin/bin"
OUT="$OUT_DIR/picker-host"
# Matches the manifest's macOS 12 minimum.
MIN_MACOS="12"

mkdir -p "$OUT_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for arch in arm64 x86_64; do
  echo "  compiling ${arch}"
  # -swift-version 5 avoids Swift 6 strict-concurrency errors against AppKit's singletons.
  swiftc -swift-version 5 -O \
    -target "${arch}-apple-macos${MIN_MACOS}" \
    -o "$TMP/picker-host-$arch" "$SRC"
done

lipo -create -output "$OUT" "$TMP/picker-host-arm64" "$TMP/picker-host-x86_64"
chmod +x "$OUT"

echo "built $OUT"
lipo -archs "$OUT" | sed 's/^/  architectures: /'
echo "  size: $(stat -f '%z' "$OUT") bytes"
