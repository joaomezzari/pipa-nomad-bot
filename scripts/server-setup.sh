#!/usr/bin/env bash
# One-time (and safe to re-run) server setup for the bot.
#
#   sudo ./scripts/server-setup.sh
#
# Creates the bot and deploy users, fixes ownership, installs deps, runs migrations,
# configures log rotation and starts the bot under pm2 with a boot service.
# The repo can live anywhere; APP_DIR is wherever this script sits.
#
# The GitHub Action logs in as DEPLOY_USER, which owns the code and may only run
# pm2 as BOT_USER. The admin (the user who ran sudo) keeps write access via ACLs.
# Pass the Action's public key to authorize it:
#
#   sudo DEPLOY_SSH_KEY=~/.ssh/github_action.pub ./scripts/server-setup.sh
#
# Env overrides: BOT_USER (default pipabot), DEPLOY_USER (default deploy),
# ADMIN_USER (default: the user who ran sudo), DEPLOY_SSH_KEY (public key file)
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BOT_USER="${BOT_USER:-pipabot}"
BOT_HOME="/home/${BOT_USER}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
ADMIN_USER="${ADMIN_USER:-${SUDO_USER:-}}"
DEPLOY_SSH_KEY="${DEPLOY_SSH_KEY:-}"
APP_NAME="pipa-dn-bot"

log()  { echo -e "\033[1;34m==>\033[0m $*"; }
warn() { echo -e "\033[1;33mWARN:\033[0m $*"; }
die()  { echo -e "\033[1;31mERROR:\033[0m $*" >&2; exit 1; }

as_deploy() { sudo -u "$DEPLOY_USER" -H bash -c "cd '$APP_DIR' && umask 002 && $*"; }
as_bot()    { sudo -u "$BOT_USER" -H "$@"; }

# --- 1. Preflight -----------------------------------------------------------
[[ $EUID -eq 0 ]] || die "Run with sudo: sudo $0"
[[ -n "$ADMIN_USER" && "$ADMIN_USER" != "root" ]] \
    || die "Run via sudo from your normal user, or set ADMIN_USER=<user who works on the code>"
[[ -z "$DEPLOY_SSH_KEY" || -f "$DEPLOY_SSH_KEY" ]] || die "DEPLOY_SSH_KEY file not found: $DEPLOY_SSH_KEY"

command -v node >/dev/null || die "node not found. Install Node.js 20+ (e.g. https://github.com/nodesource/distributions)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 20 )) || die "Node.js 20+ required, found $(node -v)"
command -v npm  >/dev/null || die "npm not found"
command -v pm2  >/dev/null || die "pm2 not found. Install it with: sudo npm install -g pm2"
command -v psql >/dev/null || warn "psql not found. Make sure DATABASE_URL points to a reachable PostgreSQL server"
if ! command -v setfacl >/dev/null; then
    log "Installing acl (setfacl)"
    apt-get install -y -qq acl >/dev/null
fi

if [[ ! -f "$APP_DIR/.env" ]]; then
    cp "$APP_DIR/.env.example" "$APP_DIR/.env"
    chown "$ADMIN_USER" "$APP_DIR/.env"
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

# --- 3. Deploy user -------------------------------------------------------------
# Created locally rather than through GCP metadata, so the guest agent never rewrites its keys.
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
    log "Creating deploy user $DEPLOY_USER"
    useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
for user in "$DEPLOY_USER" "$ADMIN_USER"; do
    if ! id -nG "$user" | tr ' ' '\n' | grep -qx "$BOT_USER"; then
        log "Adding $user to group $BOT_USER (takes effect on next login)"
        usermod -aG "$BOT_USER" "$user"
    fi
done

if [[ -n "$DEPLOY_SSH_KEY" ]]; then
    DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
    KEY_LINE="restrict $(awk '{print $1, $2}' "$DEPLOY_SSH_KEY") github-actions-deploy"
    install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEPLOY_HOME/.ssh"
    touch "$DEPLOY_HOME/.ssh/authorized_keys"
    if ! grep -qF "$(awk '{print $2}' "$DEPLOY_SSH_KEY")" "$DEPLOY_HOME/.ssh/authorized_keys"; then
        log "Authorizing $DEPLOY_SSH_KEY for $DEPLOY_USER"
        echo "$KEY_LINE" >> "$DEPLOY_HOME/.ssh/authorized_keys"
    fi
    chown "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_HOME/.ssh/authorized_keys"
    chmod 600 "$DEPLOY_HOME/.ssh/authorized_keys"
fi

# The deploy user's only privilege: driving the bot's pm2 (scripts/deploy.sh)
SUDOERS_FILE="/etc/sudoers.d/$APP_NAME-deploy"
echo "$DEPLOY_USER ALL=($BOT_USER) NOPASSWD: $(command -v pm2)" > "$SUDOERS_FILE.tmp"
chmod 440 "$SUDOERS_FILE.tmp"
visudo -cqf "$SUDOERS_FILE.tmp" || die "Generated sudoers rule is invalid"
mv "$SUDOERS_FILE.tmp" "$SUDOERS_FILE"

# --- 4. Ownership -------------------------------------------------------------
# Code belongs to the deploy user (who runs git pull); the bot can read but not modify it.
# Deploy and admin users both get write access (and inherit it on new files) via ACLs.
log "Setting ownership in $APP_DIR"
chown -R "$DEPLOY_USER:$BOT_USER" "$APP_DIR"
find "$APP_DIR" -path "$APP_DIR/node_modules" -prune -o -type d -exec chmod g+s {} +
chmod 640 "$APP_DIR/.env"
find "$APP_DIR" \( -path "$APP_DIR/auth_info" -o -path "$APP_DIR/data" -o -path "$APP_DIR/logs" \) -prune \
    -o ! -type l -exec setfacl -m "u:$DEPLOY_USER:rwX,u:$ADMIN_USER:rwX" {} +
find "$APP_DIR" \( -path "$APP_DIR/auth_info" -o -path "$APP_DIR/data" -o -path "$APP_DIR/logs" \) -prune \
    -o -type d -exec setfacl -d -m "u:$DEPLOY_USER:rwX,u:$ADMIN_USER:rwX" {} +
sudo -u "$ADMIN_USER" -H git config --global --get-all safe.directory | grep -qx "$APP_DIR" \
    || sudo -u "$ADMIN_USER" -H git config --global --add safe.directory "$APP_DIR"

# The deploy user has no GitHub credentials: fetch the public repo over HTTPS, push over SSH
ORIGIN_URL="$(as_deploy "git remote get-url origin" 2>/dev/null || true)"
if [[ "$ORIGIN_URL" =~ ^git@github\.com:(.+)$ ]]; then
    log "Switching origin fetch URL to HTTPS (push stays on SSH)"
    as_deploy "git remote set-url --push origin '$ORIGIN_URL'"
    as_deploy "git remote set-url origin 'https://github.com/${BASH_REMATCH[1]}'"
fi

# Runtime state belongs to the bot
for dir in auth_info data logs; do
    install -d -m 2770 -o "$BOT_USER" -g "$BOT_USER" "$APP_DIR/$dir"
    chown -R "$BOT_USER:$BOT_USER" "$APP_DIR/$dir"
done

# LOG_DIRECTORY may point outside the repo (e.g. /var/log/...)
LOG_DIRECTORY="$(grep -E '^LOG_DIRECTORY=' "$APP_DIR/.env" | tail -n1 | cut -d= -f2- | tr -d '"'"'" || true)"
if [[ -n "$LOG_DIRECTORY" && "$LOG_DIRECTORY" != "$APP_DIR"/* ]]; then
    log "Preparing external log directory $LOG_DIRECTORY"
    install -d -m 2770 -o "$BOT_USER" -g "$BOT_USER" "$LOG_DIRECTORY"
    chown -R "$BOT_USER:$BOT_USER" "$LOG_DIRECTORY"
fi

# --- 5. Dependencies and database ----------------------------------------------
if [[ ! -f "$APP_DIR/node_modules/.package-lock.json" || "$APP_DIR/package-lock.json" -nt "$APP_DIR/node_modules/.package-lock.json" ]]; then
    log "Installing dependencies (npm ci, also generates the Prisma client)"
    as_deploy "npm ci"
else
    log "Dependencies up to date, skipping npm ci"
fi
log "Applying database migrations"
as_deploy "npm run db:migrate"

# --- 6. Log rotation ----------------------------------------------------------
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

# --- 7. pm2 -------------------------------------------------------------------
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

# --- 8. Done ------------------------------------------------------------------
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
