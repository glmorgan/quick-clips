#!/bin/bash
#
# Diagnoses why the transform picker is not appearing on a given machine.
#
# Safe to run: it only reads state and, at the end, launches the picker host against a
# throwaway local page for two seconds. It changes nothing.
#
# Usage:  bash native/diagnose.sh
#     or paste the whole file into a terminal.
#
PLUGIN="$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.quickclips.streamdeck.sdPlugin"
HOST="$PLUGIN/bin/picker-host"

say() { printf '\n=== %s ===\n' "$1"; }

say "machine"
sw_vers | sed 's/^/  /'
printf '  arch: %s\n' "$(uname -m)"

say "installed plugin"
if [ -L "$PLUGIN" ]; then
  printf '  symlink -> %s\n' "$(readlink "$PLUGIN")"
  printf '  (a dev symlink, not an installed release)\n'
elif [ -d "$PLUGIN" ]; then
  printf '  installed directory\n'
else
  printf '  NOT FOUND at %s\n' "$PLUGIN"
  exit 1
fi
if [ -f "$PLUGIN/manifest.json" ]; then
  printf '  Version: %s\n' "$(grep -o '"Version"[^,]*' "$PLUGIN/manifest.json" | head -1)"
fi

say "native host"
if [ -f "$HOST" ]; then
  printf '  present, mode %s, %s bytes\n' "$(stat -f '%Sp' "$HOST")" "$(stat -f '%z' "$HOST")"
  if [ -x "$HOST" ]; then printf '  executable: yes\n'
  else printf '  executable: NO — the plugin repairs this on first use\n'; fi
  printf '  architectures: %s\n' "$(lipo -archs "$HOST" 2>/dev/null || echo '?')"
  q=$(xattr -p com.apple.quarantine "$HOST" 2>/dev/null)
  if [ -n "$q" ]; then
    printf '  QUARANTINED: %s\n' "$q"
    printf '  Gatekeeper will block it; the picker should fall back to a browser.\n'
  else
    printf '  quarantine: none\n'
  fi
else
  printf '  NOT PRESENT — this build shipped without the native host\n'
fi

say "browser fallbacks available"
found=0
for a in "Google Chrome" "Microsoft Edge" "Brave Browser" "Chromium" "Vivaldi"; do
  p="/Applications/$a.app/Contents/MacOS/$a"
  [ -x "$p" ] && { printf '  %s\n' "$a"; found=1; }
done
[ "$found" = 0 ] && printf '  none — the picker will use the osascript list\n'

say "plugin logs"
LOGS="$PLUGIN/logs"
if [ -d "$LOGS" ]; then
  ls -t "$LOGS" 2>/dev/null | head -3 | sed 's/^/  /'
  newest=$(ls -t "$LOGS"/*.log 2>/dev/null | head -1)
  if [ -n "$newest" ]; then
    printf '  --- last 25 lines of %s ---\n' "$(basename "$newest")"
    tail -25 "$newest" | sed 's/^/  /'
  fi
else
  printf '  no logs directory (plugin logging needs developer mode: npx streamdeck dev)\n'
fi

say "can the host actually execute?"
if [ -x "$HOST" ]; then
  out=$("$HOST" 2>&1); code=$?
  printf '  no-args exit code: %s\n' "$code"
  printf '  output: %s\n' "${out:-（none)}"
  if [ "$code" = 2 ]; then
    printf '  GOOD: it ran and printed its usage message.\n'
  else
    printf '  BAD: it did not run normally (expected exit 2 with a usage line).\n'
  fi
else
  printf '  skipped: not executable\n'
fi

say "does it open a window? (2 second test)"
if [ -x "$HOST" ]; then
  DIR=$(mktemp -d)
  printf '<!doctype html><title>t</title><body style="background:#2d7">DIAGNOSTIC WINDOW</body>' > "$DIR/index.html"
  ( cd "$DIR" && python3 -m http.server 8931 >/dev/null 2>&1 & echo $! > "$DIR/pid" )
  sleep 1
  "$HOST" --app=http://127.0.0.1:8931/ --window-size=520,300 2>"$DIR/err" &
  hpid=$!
  sleep 2
  kill "$hpid" 2>/dev/null
  kill "$(cat "$DIR/pid")" 2>/dev/null
  printf '  host stderr: %s\n' "$(cat "$DIR/err" 2>/dev/null || echo '(none)')"
  printf '  A small green window should have appeared for ~2s.\n'
  printf '  If it did NOT, the native window itself is the problem.\n'
  printf '  If it appeared but was BLANK, the page is not loading.\n'
  rm -rf "$DIR"
else
  printf '  skipped: not executable\n'
fi

printf '\n=== done ===\n'
