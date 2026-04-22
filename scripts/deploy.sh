#!/usr/bin/env bash
# deploy.sh — Install/restart xpoz-pipeline as a systemd service
#
# Usage:
#   ./scripts/deploy.sh          # first deploy (install + enable + start)
#   ./scripts/deploy.sh restart  # restart service after code changes
#   ./scripts/deploy.sh status   # check service status + logs
#   ./scripts/deploy.sh stop     # stop service

set -euo pipefail

SERVICE=xpoz-pipeline
SERVICE_FILE=/etc/systemd/system/${SERVICE}.service
PROJECT_DIR=/root/claude/projects/xpoz-pipeline
ENV_FILE=${PROJECT_DIR}/.env

log() { echo "[deploy] $*"; }

# ── Ensure .env exists ────────────────────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  log "Creating .env from environment..."
  cat > "$ENV_FILE" <<ENVFILE
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID:-}
XPOZ_API_KEY=${XPOZ_API_KEY:-}
ENVFILE
  log ".env written to $ENV_FILE"
fi

# ── Subcommands ───────────────────────────────────────────────────────────────
CMD="${1:-install}"

case "$CMD" in
  restart)
    log "Restarting $SERVICE..."
    systemctl restart "$SERVICE"
    sleep 3
    systemctl is-active "$SERVICE" && log "Service active ✓" || log "WARNING: Service not active"
    journalctl -u "$SERVICE" --since "10 sec ago" --no-pager | tail -10
    ;;
  status)
    systemctl status "$SERVICE" --no-pager -l
    echo "---"
    journalctl -u "$SERVICE" --since "5 min ago" --no-pager | tail -20
    ;;
  stop)
    log "Stopping $SERVICE..."
    systemctl stop "$SERVICE"
    log "Service stopped."
    ;;
  install|*)
    log "Installing $SERVICE as systemd service..."

    # Copy service file
    cp "${PROJECT_DIR}/xpoz-pipeline.service" "$SERVICE_FILE"
    log "Service file installed at $SERVICE_FILE"

    # Reload systemd
    systemctl daemon-reload
    log "systemd reloaded"

    # Enable + start
    systemctl enable "$SERVICE"
    systemctl restart "$SERVICE"
    sleep 3

    # Verify
    if systemctl is-active --quiet "$SERVICE"; then
      log "✅ Service $SERVICE is running"
      log "API available at: http://localhost:8086"
      log "Check logs: journalctl -u $SERVICE -f"
    else
      log "❌ Service failed to start"
      journalctl -u "$SERVICE" --since "30 sec ago" --no-pager | tail -20
      exit 1
    fi
    ;;
esac
