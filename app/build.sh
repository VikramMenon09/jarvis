#!/bin/zsh
# Builds Jarvis.app and puts it in /Applications. Builds outside Desktop because iCloud adds metadata that breaks signing.
set -e
SRC="${0:A:h}"
B="$(mktemp -d)"
OUT="$B/Jarvis.app"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
swiftc -O -swift-version 5 "$SRC/main.swift" -o "$OUT/Contents/MacOS/Jarvis"
cp "$SRC/Info.plist" "$OUT/Contents/Info.plist"
swiftc -swift-version 5 "$SRC/icon.swift" -o "$B/mkicon" && "$B/mkicon" "$B/icon.png"
mkdir "$B/Jarvis.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$B/icon.png" --out "$B/Jarvis.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$B/icon.png" --out "$B/Jarvis.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$B/Jarvis.iconset" -o "$OUT/Contents/Resources/Jarvis.icns"
xattr -cr "$OUT"
codesign --force -s - "$OUT"
pkill -x Jarvis 2>/dev/null || true
rm -rf /Applications/Jarvis.app && cp -R "$OUT" /Applications/Jarvis.app
rm -rf "$B"
echo "Built /Applications/Jarvis.app"
