#!/bin/zsh
# Makes Jarvis start at login and restart itself if it ever stops.
set -e
DIR="${0:A:h}"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/com.jarvis.agent.plist"
mkdir -p "$DIR/data" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.jarvis.agent</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string><string>$DIR/server.js</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${NODE:h}:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/Jarvis.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/Jarvis.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/com.jarvis.agent" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
# Open the Jarvis app at login.
APP="$HOME/Library/LaunchAgents/com.jarvis.app.plist"
cat > "$APP" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.jarvis.app</string>
  <key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-a</string><string>/Applications/Jarvis.app</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/com.jarvis.app" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$APP"
echo "Jarvis is installed and running. Console: http://127.0.0.1:4747"
echo "Grant Full Disk Access to: $(readlink -f "$NODE" 2>/dev/null || echo "$NODE")"
