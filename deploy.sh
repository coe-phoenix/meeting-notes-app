#!/usr/bin/env bash
# Redeploy the latest main branch. Run this from /opt/meeting-notes-app on the server:
#   ./deploy.sh
set -euo pipefail

APP_NAME="meeting-notes-app"
cd "$(dirname "$0")"

echo "==> Checking for local changes to .env (never touched by this script)"
if [ -f .env ]; then
  echo "    .env present — left untouched."
else
  echo "    WARNING: no .env found. Copy .env.example to .env and fill in keys before this will work."
fi

echo "==> Fetching latest code"
OLD_HASH="$(git rev-parse HEAD)"
git fetch origin main
git reset --hard origin/main
NEW_HASH="$(git rev-parse HEAD)"

if [ "$OLD_HASH" = "$NEW_HASH" ]; then
  echo "==> Already up to date ($NEW_HASH). Restarting anyway in case of a prior failed start."
else
  echo "==> Updated $OLD_HASH -> $NEW_HASH"
  echo "==> Changed files:"
  git diff --name-only "$OLD_HASH" "$NEW_HASH" | sed 's/^/    /'
fi

# Always install: it's fast and idempotent when nothing changed, and it
# guarantees native deps (e.g. better-sqlite3) are present. Skipping this on a
# stale/re-fetched commit was how a missing module crash-looped a deploy before.
echo "==> Installing production dependencies (npm install --production)"
npm install --production

echo "==> Restarting $APP_NAME"
pm2 restart "$APP_NAME"

echo ""
echo "==> Status"
pm2 status "$APP_NAME"

echo ""
echo "==> Recent logs (last 20 lines)"
pm2 logs "$APP_NAME" --lines 20 --nostream

echo ""
echo "==> Done. If you see errors above, run: pm2 logs $APP_NAME --lines 100 --nostream"
