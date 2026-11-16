#!/usr/bin/env bash
# Installs the ingestion worker as a launchd user agent: starts at login,
# restarts on crash. Re-running it reinstalls cleanly.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(command -v node)"
LABEL="com.goldensierra.worker"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$HOME/Library/LaunchAgents" "$DIR/logs"
sed -e "s#__DIR__#$DIR#g" -e "s#__NODE__#$NODE#g" \
  "$DIR/deploy/$LABEL.plist" > "$TARGET"

# bootout is how a running agent is replaced; it fails when none is loaded.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$TARGET"
launchctl enable "gui/$UID/$LABEL"

echo "Installed $LABEL"
echo "  status:  launchctl print gui/$UID/$LABEL | head -20"
echo "  logs:    tail -f $DIR/logs/worker.log"
echo "  stop:    launchctl bootout gui/$UID/$LABEL"
