#!/bin/bash
# Run on the production host after copying/pulling new code to /opt/psa
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/psa}"
APP_USER="${APP_USER:-psa}"

echo "==> Installing dependencies in ${APP_DIR}"
cd "$APP_DIR"
sudo -u "$APP_USER" npm install --omit=dev

echo "==> Ensuring attachment storage exists"
sudo -u "$APP_USER" mkdir -p "$APP_DIR/data/attachments"

echo "==> Restarting psa service"
sudo systemctl restart psa
sleep 2

echo "==> Service status"
sudo systemctl status psa --no-pager -l || true

echo "==> Recent logs"
sudo journalctl -u psa -n 30 --no-pager || true

echo "==> Local health check"
if curl -sf "http://127.0.0.1:${PORT:-3000}/login" >/dev/null; then
  echo "OK — app responding on port ${PORT:-3000}"
else
  echo "FAIL — app not responding. Check: journalctl -u psa -n 50"
  exit 1
fi
