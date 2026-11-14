#!/usr/bin/env bash
# Install or upgrade the app on the Orgo computer that runs Hermes. Run it ON that computer, as root.
#
#   PUBLIC_URL=https://<name>.orgo.dev ORGO_COMPUTER_ID=<uuid> ALLOWED_EMAILS=you@example.com \
#     bash install-on-computer.sh /path/to/hq-app.tgz
#
# Optional: PORT (8787), PRIMARY_CDP_URL (DevTools URL of the main agent's own Chrome, if it has one),
# DEV_LOGIN=1 (test machines only), KEYS_FILE (lines XAI_API_KEY=, COMPOSIO_API_KEY=, ORGO_API_KEY=).
# ORGO_API_KEY may be left out of KEYS_FILE when Hermes' own .env already has one.
# DRY_RUN=1 prints every step and changes nothing: no unpack, no install, no .env, no restart.
#
# It never restarts Hermes and never touches its config: adding the app's tools to the main agent is a
# separate, printed step (see the end of the output).
set -euo pipefail
tgz="${1:?usage: install-on-computer.sh <hq-app.tgz>}"
APP=/opt/hq/app; DATA=/opt/hq/data; NODE_DIR=/opt/hq/node; NODE_V=v22.21.1
PORT="${PORT:-8787}"; HERMES_HOME_DIR="${HERMES_HOME_PRIMARY:-/root/.hermes}"
DRY="${DRY_RUN:-0}"
dry() { [ "$DRY" = "1" ]; }
umask 077
if dry; then echo "(dry run) nothing will be written to $APP, $DATA, $NODE_DIR or /var/log/hq"; else
mkdir -p "$APP" "$DATA" "$NODE_DIR" /var/log/hq
fi

# 1. A private Node (the system one may be too old, and we leave it alone). It ships corepack, which
#    is what supplies the pnpm version the workspace's package.json pins.
if dry; then
  echo "(dry run) would install Node $NODE_V into $NODE_DIR when it is missing"
elif ! "$NODE_DIR/bin/node" -v 2>/dev/null | grep -q '^v22\.'; then
  curl -fsSL "https://nodejs.org/dist/$NODE_V/node-$NODE_V-linux-x64.tar.gz" | tar -xz -C "$NODE_DIR" --strip-components=1
fi
export PATH="$NODE_DIR/bin:$PATH"

# 2. The app. Data lives outside it, so an upgrade only replaces code.
if dry; then
  echo "(dry run) would unpack $tgz into $APP and install production dependencies with pnpm"
else
rm -rf "$APP/apps/server/dist" "$APP/apps/web/dist" "$APP"/packages/*/dist
tar -xzf "$tgz" -C "$APP"
# pnpm, not npm: this is a pnpm workspace, and the server's workspace dependencies (@orbit/contracts,
# @orbit/logger) are workspace: links that only resolve under pnpm. --filter keeps the install to the
# server's own graph (apps/web's devDependencies, and turbo at the root, are not needed to run it).
# --ignore-scripts: the SQLite package ships ready-made binaries and this computer has no compilers —
# without it pnpm tries to compile better-sqlite3.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack enable --install-directory "$NODE_DIR/bin" >/dev/null 2>&1 || corepack enable >/dev/null 2>&1 || true
log=/var/log/hq/pnpm.log
if ! (cd "$APP" && pnpm install --prod --frozen-lockfile --ignore-scripts \
      --filter "@orbit/server..." --reporter=append-only >"$log" 2>&1); then
  # The pack's lockfile can name a workspace project that is not in the pack (another app was added
  # since the pack was built). Resolve instead of failing the install.
  echo "frozen install failed (see $log); retrying without --frozen-lockfile"
  (cd "$APP" && pnpm install --prod --ignore-scripts --filter "@orbit/server..." \
    --reporter=append-only >>"$log" 2>&1) || { tail -20 "$log"; exit 1; }
fi
fi

# 3. Settings, written once. Later runs keep the file (and so the session secret and every bot's token).
if dry; then
  echo "(dry run) would write $APP/.env on first install (SESSION_SECRET generated there)"
elif [ ! -f "$APP/.env" ]; then
  : "${PUBLIC_URL:?PUBLIC_URL is required on first install}" "${ORGO_COMPUTER_ID:?ORGO_COMPUTER_ID is required on first install}"
  # A key that is not in the file is simply empty (grep finding nothing must not stop the script).
  key() { { grep -E "^$1=" "$2" 2>/dev/null || true; } | tail -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
  K="${KEYS_FILE:-/dev/null}"
  orgo="$(key ORGO_API_KEY "$K")"; [ -n "$orgo" ] || orgo="$(key ORGO_API_KEY "$HERMES_HOME_DIR/.env")"
  [ -n "$orgo" ] || { echo "No ORGO_API_KEY in KEYS_FILE or $HERMES_HOME_DIR/.env"; exit 1; }
  {
    echo "PORT=$PORT"
    echo "APP_URL=$PUBLIC_URL"
    echo "SERVER_URL=$PUBLIC_URL"
    echo "SESSION_SECRET=$(openssl rand -hex 32)"
    echo "DEV_LOGIN=${DEV_LOGIN:-0}"
    echo "ALLOWED_EMAILS=${ALLOWED_EMAILS:-}"
    echo "DB_PATH=$DATA/hq.db"
    echo "ENGINES_DIR=$DATA/engines"
    echo "HERMES_BIN=$(command -v hermes || echo /usr/local/bin/hermes)"
    echo "HERMES_URL=http://127.0.0.1:8642"
    echo "HERMES_HOME_PRIMARY=$HERMES_HOME_DIR"
    echo "HERMES_KEY=$(key API_SERVER_KEY "$HERMES_HOME_DIR/.env")"
    echo "HQ_LOCAL=1"
    echo "ORGO_COMPUTER_ID=$ORGO_COMPUTER_ID"
    echo "PRIMARY_CDP_URL=${PRIMARY_CDP_URL:-}"
    echo "ORGO_API_KEY=$orgo"
    echo "XAI_API_KEY=$(key XAI_API_KEY "$K")"
    echo "COMPOSIO_API_KEY=$(key COMPOSIO_API_KEY "$K")"
    xm="$(key XAI_MODEL "$K")"; [ -z "$xm" ] || echo "XAI_MODEL=$xm"
    [ -z "${PRIMARY_BOT_NAME:-}" ] || echo "PRIMARY_BOT_NAME=$PRIMARY_BOT_NAME"
    [ -z "${PRIMARY_BOT_LABEL:-}" ] || echo "PRIMARY_BOT_LABEL=$PRIMARY_BOT_LABEL"
  } > "$APP/.env"
  chmod 600 "$APP/.env"
fi
[ "$DRY" = "1" ] || [ -z "${KEYS_FILE:-}" ] || rm -f "$KEYS_FILE"

# 4. Keep it running. Only this one program is added or restarted; nothing else under supervisor is touched.
if dry; then
  echo "(dry run) would write /etc/supervisor/conf.d/hq-app.conf and (re)start hq-app"
else
cat > /etc/supervisor/conf.d/hq-app.conf <<EOF
[program:hq-app]
command=$NODE_DIR/bin/node --env-file=$APP/.env $APP/apps/server/dist/index.js
directory=$APP
autostart=true
autorestart=true
startsecs=3
stopasgroup=false
killasgroup=false
stdout_logfile=/var/log/hq/app.log
stdout_logfile_maxbytes=10MB
redirect_stderr=true
environment=HOME="/root",PATH="$NODE_DIR/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
EOF
chmod 644 /etc/supervisor/conf.d/hq-app.conf
supervisorctl reread >/dev/null
if supervisorctl status hq-app 2>/dev/null | grep -qE 'RUNNING|STARTING|BACKOFF|FATAL|EXITED|STOPPED'; then
  supervisorctl restart hq-app >/dev/null
else
  supervisorctl add hq-app >/dev/null
fi
for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$PORT/api/health" && echo
fi

# 5. What to add to the main agent's Hermes config so it gets the app's tools (never done here).
if dry; then
  echo "(dry run) would write $DATA/hermes-mcp-hq.yaml (the main agent's MCP entry)"
else
secret="$(grep -E '^SESSION_SECRET=' "$APP/.env" | cut -d= -f2-)"
tok="$(printf 'mcp:primary' | openssl dgst -sha256 -hmac "$secret" -r | cut -d' ' -f1)"
umask 077
cat > "$DATA/hermes-mcp-hq.yaml" <<EOF
# Add under mcp_servers: in $HERMES_HOME_DIR/config.yaml (Hermes picks it up without a restart).
  hq:
    url: http://127.0.0.1:$PORT/mcp/primary
    headers:
      Authorization: Bearer $tok
    timeout: 1800
    connect_timeout: 30
EOF
echo "installed. main agent's MCP entry: $DATA/hermes-mcp-hq.yaml"
fi
