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

# ffmpeg is required to concatenate live-recording segments into one file and to
# produce the mp3 convenience download (Phase 3). Uploads still work without it,
# so a failed install warns rather than aborting the whole deploy.
echo "==> Ensuring ffmpeg is installed (Phase 3: audio concat + mp3 downloads)"
if command -v ffmpeg >/dev/null 2>&1; then
  echo "    ffmpeg present: $(ffmpeg -version | head -1)"
elif command -v apt-get >/dev/null 2>&1; then
  echo "    ffmpeg missing — installing via apt-get"
  sudo apt-get update -y && sudo apt-get install -y ffmpeg \
    || echo "    WARNING: automatic ffmpeg install failed. Install manually: sudo apt-get install -y ffmpeg"
else
  echo "    WARNING: ffmpeg missing and apt-get not found. Install ffmpeg for this distro manually."
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
