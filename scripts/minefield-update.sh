#!/bin/bash
# Minefield custom-build updater for an MCSManager install at /opt/mcsmanager.
#
# Builds this fork from GitHub on the server and installs it over the existing
# install. data/, logs/ and daemon/lib/ are never touched.
#
# Usage (as root):
#   bash minefield-update.sh            # update the panel (web) only
#   bash minefield-update.sh daemon     # update the daemon only (stops game servers!)
#   bash minefield-update.sh all        # panel + daemon
#   bash minefield-update.sh rollback <backup-dir>
#
# Environment overrides: MCSM, BRANCH, REPO_URL, SRC.

set -euo pipefail

MCSM="${MCSM:-/opt/mcsmanager}"
REPO_URL="${REPO_URL:-https://github.com/yiittv/mcsmanager.git}"
BRANCH="${BRANCH:-claude/clever-feynman-lza93g}"
SRC="${SRC:-/opt/minefield-src}"
BACKUP_ROOT="/opt/mcsm-backup"
TARGET="${1:-web}"

log() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
[ -d "$MCSM/web" ] && [ -d "$MCSM/daemon" ] || die "MCSManager not found at $MCSM"

NODE_DIR="$(find "$MCSM" -maxdepth 1 -type d -name 'node-v*-linux-*' | sort | tail -n1)"
[ -n "$NODE_DIR" ] || die "bundled Node.js not found in $MCSM"
export PATH="$NODE_DIR/bin:$PATH"

restart_and_check_web() {
  systemctl restart mcsm-web
  for _ in $(seq 1 30); do
    if curl -fsS -m 3 http://127.0.0.1:23333/api/auth/status >/dev/null 2>&1; then
      log "Panel is up"
      return 0
    fi
    sleep 2
  done
  return 1
}

restart_and_check_daemon() {
  systemctl restart mcsm-daemon
  sleep 5
  systemctl is-active --quiet mcsm-daemon
}

if [ "$TARGET" = "rollback" ]; then
  BK="${2:-}"
  [ -n "$BK" ] && [ -d "$BK" ] || die "usage: $0 rollback /opt/mcsm-backup/<timestamp>"
  if [ -f "$BK/web-code.tgz" ]; then
    log "Restoring panel from $BK"
    rm -rf "$MCSM/web/public"
    tar -xzf "$BK/web-code.tgz" -C "$MCSM/web"
    restart_and_check_web || die "panel did not come back; check: journalctl -u mcsm-web -n 50"
  fi
  if [ -f "$BK/daemon-code.tgz" ]; then
    log "Restoring daemon from $BK"
    tar -xzf "$BK/daemon-code.tgz" -C "$MCSM/daemon"
    restart_and_check_daemon || die "daemon did not come back; check: journalctl -u mcsm-daemon -n 50"
  fi
  log "Rollback finished"
  exit 0
fi

case "$TARGET" in
  web | daemon | all) ;;
  *) die "unknown target '$TARGET' (use web, daemon, all, rollback)" ;;
esac

if [ "$TARGET" != "web" ]; then
  echo
  echo "WARNING: restarting the daemon STOPS ALL GAME SERVERS."
  echo "Stop them from the panel first. Type 'yes' to continue:"
  read -r answer
  [ "$answer" = "yes" ] || die "aborted"
fi

command -v git >/dev/null || { log "Installing git"; apt-get install -y git >/dev/null; }

log "Fetching source ($BRANCH)"
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch --depth 1 origin "$BRANCH"
  git -C "$SRC" reset --hard FETCH_HEAD
else
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$SRC"
fi
log "Source at commit $(git -C "$SRC" rev-parse --short HEAD)"

log "Installing build dependencies (first run takes a few minutes)"
export NODE_OPTIONS="--max-old-space-size=2048"
for d in common panel daemon frontend; do
  (cd "$SRC/$d" && npm ci --no-audit --no-fund --loglevel=error)
done

log "Building"
(cd "$SRC" && sh ./build.sh)
OUT="$SRC/production-code"
[ -f "$OUT/web/app.js" ] && [ -f "$OUT/daemon/app.js" ] && [ -f "$OUT/web/public/index.html" ] ||
  die "build output incomplete"

TS="$(date +%Y%m%d-%H%M%S)"
BK="$BACKUP_ROOT/$TS"
mkdir -p "$BK"
chmod 700 "$BACKUP_ROOT"

if [ "$TARGET" = "web" ] || [ "$TARGET" = "all" ]; then
  log "Backing up panel code to $BK"
  tar -czf "$BK/web-code.tgz" -C "$MCSM/web" app.js package.json public $(cd "$MCSM/web" && ls app.js.map package-lock.json 2>/dev/null)
  log "Installing panel"
  rm -rf "$MCSM/web/public"
  cp -a "$OUT/web/public" "$MCSM/web/public"
  cp -f "$OUT/web/app.js" "$OUT/web/app.js.map" "$OUT/web/package.json" "$MCSM/web/"
  restart_and_check_web || {
    echo "Panel failed to start, rolling back"
    bash "$0" rollback "$BK"
    exit 1
  }
fi

if [ "$TARGET" = "daemon" ] || [ "$TARGET" = "all" ]; then
  log "Backing up daemon code to $BK"
  tar -czf "$BK/daemon-code.tgz" -C "$MCSM/daemon" app.js package.json $(cd "$MCSM/daemon" && ls app.js.map package-lock.json 2>/dev/null)
  log "Installing daemon"
  cp -f "$OUT/daemon/app.js" "$OUT/daemon/app.js.map" "$OUT/daemon/package.json" "$MCSM/daemon/"
  restart_and_check_daemon || {
    echo "Daemon failed to start, rolling back"
    tar -xzf "$BK/daemon-code.tgz" -C "$MCSM/daemon"
    restart_and_check_daemon || true
    exit 1
  }
fi

log "Done. Backup: $BK"
echo "To undo: bash $0 rollback $BK"
