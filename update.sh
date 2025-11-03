#!/data/data/com.termux/files/usr/bin/bash
# update.sh - safe updater for StaticBot on Termux
#  - backups auth_info
#  - fetches and resets to origin/main
#  - installs new dependencies
#  - restarts the bot using start-termux.sh (or node index.js)

set -euo pipefail

# autodetect repository directory (directory where this script lives)
DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$DIR"
cd "$REPO_DIR" || { echo "Repo dir not found: $REPO_DIR"; exit 1; }

echo "[update.sh] Backing up auth_info..."
if [ -d auth_info ]; then
  BACKUP_DIR="auth_info_backup_$(date +%Y%m%d%H%M%S)"
  cp -r auth_info "$BACKUP_DIR" || echo "Warning: failed to copy auth_info"
  echo "[update.sh] auth_info backed up to $BACKUP_DIR"
else
  echo "[update.sh] No auth_info folder found; skipping backup"
fi

echo "[update.sh] Fetching and resetting to origin/main..."
git fetch origin --quiet || { echo "git fetch failed"; exit 1; }
git reset --hard origin/main || { echo "git reset failed"; exit 1; }

echo "[update.sh] Installing npm packages (if any)..."
npm install --silent || { echo "npm install failed"; exit 1; }

echo "[update.sh] Restarting bot"
# kill any running node index.js processes
pkill -f "node index.js" || true

if [ -x ./start-termux.sh ]; then
  echo "[update.sh] Using start-termux.sh to start the bot"
  nohup ./start-termux.sh > bot.log 2>&1 &
else
  echo "[update.sh] start-termux.sh not found; starting node index.js in background"
  nohup node index.js > bot.log 2>&1 &
fi

echo "[update.sh] Update complete. Logs -> $REPO_DIR/bot.log"
