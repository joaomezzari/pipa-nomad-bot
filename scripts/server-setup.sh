#!/usr/bin/env bash
# One-time (and safe to re-run) server setup for the bot.
#
#   sudo ./scripts/server-setup.sh
#
# Creates the bot user, fixes ownership, installs deps, runs migrations,
# configures log rotation and starts the bot under pm2 with a boot service.
# The repo can live anywhere; APP_DIR is wherever this script sits.
#
# Env overrides: BOT_USER (default pipabot), DEPLOY_USER (default: the user who ran sudo)
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BOT_USER="${BOT_USER:-pipabot}"
BOT_HOME="/home/${BOT_USER}"
DEPLOY_USER="${DEPLOY_USER:-${SUDO_USER:-}}"
APP_NAME="pipa-dn-bot"

log()  { echo -e "\033[1;34m==>\033[0m $*"; }
warn() { echo -e "\033[1;33mWARN:\033[0m $*"; }
die()  { echo -e "\033[1;31mERROR:\033[0m $*" >&2; exit 1; }

as_deploy() { sudo -u "$DEPLOY_USER" -H bash -c "cd '$APP_DIR' && umask 002 && $*"; }
as_bot()    { sudo -u "$BOT_USER" -H "$@"; }

# --- 1. Preflight -----------------------------------------------------------
[[ $EUID -eq 0 ]] || die "Run with sudo: sudo $0"
[[ -n "$DEPLOY_USER" && "$DEPLOY_USER" != "root" ]] \
    || die "Run via sudo from your normal user, or set DEPLOY_USER=<user that owns the code>"

command -v node >/dev/null || die "node not found. Install Node.js 20+ (e.g. https://github.com/nodesource/distributions)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 20 )) || die "Node.js 20+ required, found $(node -v)"
command -v npm  >/dev/null || die "npm not found"
command -v pm2  >/dev/null || die "pm2 not found. Install it with: sudo npm install -g pm2"
command -v psql >/dev/null || warn "psql not found. Make sure DATABASE_URL points to a reachable PostgreSQL server"

if [[ ! -f "$APP_DIR/.env" ]]; then
    cp "$APP_DIR/.env.example" "$APP_DIR/.env"
    chown "$DEPLOY_USER" "$APP_DIR/.env"
    die "Created $APP_DIR/.env from .env.example. Fill it in and re-run this script."
fi

# Never run two bots on the same WhatsApp session
OTHER_BOT="$(ps -eo user=,pid=,args= | grep '[p]ipa-dn-bot.js' | grep -v "^${BOT_USER} " || true)"
[[ -z "$OTHER_BOT" ]] || die "Another bot instance is running (stop it first, two instances will kick each other off WhatsApp):\n$OTHER_BOT"

# --- 2. Bot user --------------------------------------------------------------
if ! id "$BOT_USER" >/dev/null 2>&1; then
    log "Creating system user $BOT_USER"
    useradd --system --create-home --home-dir "$BOT_HOME" --shell /usr/sbin/nologin "$BOT_USER"
fi
if ! id -nG "$DEPLOY_USER" | tr ' ' '\n' | grep -qx "$BOT_USER"; then
    log "Adding $DEPLOY_USER to group $BOT_USER (takes effect on next login)"
    usermod -aG "$BOT_USER" "$DEPLOY_USER"
fi

# --- 3. Ownership -------------------------------------------------------------
# Code belongs to the deploy user (who runs git pull); the bot can read but not modify it.
log "Setting ownership in $APP_DIR"
chown -R "$DEPLOY_USER:$BOT_USER" "$APP_DIR"
find "$APP_DIR" -path "$APP_DIR/node_modules" -prune -o -type d -exec chmod g+s {} +

# Runtime state belongs to the bot
for dir in auth_info data logs; do
    install -d -m 2770 -o "$BOT_USER" -g "$BOT_USER" "$APP_DIR/$dir"
    chown -R "$BOT_USER:$BOT_USER" "$APP_DIR/$dir"
done
chmod 640 "$APP_DIR/.env"

# LOG_DIRECTORY may point outside the repo (e.g. /var/log/...)
LOG_DIRECTORY="$(grep -E '^LOG_DIRECTORY=' "$APP_DIR/.env" | tail -n1 | cut -d= -f2- | tr -d '"'"'" || true)"
if [[ -n "$LOG_DIRECTORY" && "$LOG_DIRECTORY" != "$APP_DIR"/* ]]; then
    log "Preparing external log directory $LOG_DIRECTORY"
    install -d -m 2770 -o "$BOT_USER" -g "$BOT_USER" "$LOG_DIRECTORY"
    chown -R "$BOT_USER:$BOT_USER" "$LOG_DIRECTORY"
fi

# --- 4. Dependencies and database ----------------------------------------------
if [[ ! -f "$APP_DIR/node_modules/.package-lock.json" || "$APP_DIR/package-lock.json" -nt "$APP_DIR/node_modules/.package-lock.json" ]]; then
    log "Installing dependencies (npm ci, also generates the Prisma client)"
    as_deploy "npm ci"
else
    log "Dependencies up to date, skipping npm ci"
fi
log "Applying database migrations"
as_deploy "npm run db:migrate"

# --- 5. Log rotation ----------------------------------------------------------
log "Writing /etc/logrotate.d/$APP_NAME"
cat > "/etc/logrotate.d/$APP_NAME" <<EOF
$APP_DIR/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su $BOT_USER $BOT_USER
}
EOF

# --- 6. pm2 -------------------------------------------------------------------
if as_bot pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    log "$APP_NAME already registered in $BOT_USER's pm2, leaving it running"
else
    log "Starting $APP_NAME under $BOT_USER"
    as_bot pm2 start "$APP_DIR/ecosystem.config.js"
fi
as_bot pm2 save

if ! systemctl is-enabled "pm2-$BOT_USER" >/dev/null 2>&1; then
    log "Registering pm2 boot service pm2-$BOT_USER"
    env PATH="$PATH:$(dirname "$(command -v node)")" pm2 startup systemd -u "$BOT_USER" --hp "$BOT_HOME"
fi

# --- 7. Done ------------------------------------------------------------------
as_bot pm2 ls
cat <<EOF

Done. Useful commands:
  sudo -u $BOT_USER -H pm2 logs $APP_NAME     # live logs
  sudo -u $BOT_USER -H pm2 restart $APP_NAME  # restart
  tail -f $APP_DIR/logs/pm2-out.log

If this is a brand-new WhatsApp session, a QR code is printed in the logs: scan it
from the bot's phone (WhatsApp > Linked devices). To keep an existing session instead,
stop the old bot, copy its auth_info/ into $APP_DIR/auth_info/ and re-run this script.
EOF
