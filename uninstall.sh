#!/bin/zsh
# Stops Jarvis and removes it from login. Your data folder is left alone.
launchctl bootout "gui/$(id -u)/com.jarvis.agent" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/com.jarvis.app" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.jarvis.agent.plist" "$HOME/Library/LaunchAgents/com.jarvis.app.plist"
echo "Jarvis is stopped and will not start at login."
