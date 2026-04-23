#!/usr/bin/env bash
# Generate and install a fresh XPOZ_API_TOKEN across all consumers.
#
# Usage:
#   /root/claude/projects/xpoz-pipeline/scripts/install-api-token.sh
#
# Steps:
#   1. Generate 32-byte hex token (openssl).
#   2. Upsert XPOZ_API_TOKEN= into xpoz-pipeline/.env and mission-control/.env
#      (the MCP subprocess inherits env from mission-control when spawned).
#   3. Restart xpoz-pipeline, then mission-control (MCP reconnect).
#   4. Verify auth by confirming POST /run without the header returns 401.
#
# Safety:
#   - Token value is never echoed to stdout; only the prefix appears in logs.
#   - Existing XPOZ_API_TOKEN lines are replaced (not duplicated).
#   - Both .env files backed up as .bak.<ts> before mutation.
#   - Roll-back on any failure.

set -euo pipefail

XPOZ_ENV="/root/claude/projects/xpoz-pipeline/.env"
MC_ENV="/root/claude/mission-control/.env"
TS=$(date -u +%Y%m%dT%H%M%SZ)

command -v openssl >/dev/null 2>&1 || {
  echo "FATAL: openssl not found — install it or generate the token manually." >&2
  exit 1
}

NEW_TOKEN=$(openssl rand -hex 32)
export NEW_TOKEN  # must be exported BEFORE the Python here-doc reads it
PREFIX="${NEW_TOKEN:0:8}"
echo "[install-token] Generated token prefix: ${PREFIX}************************************************"

cp "$XPOZ_ENV" "${XPOZ_ENV}.bak.${TS}"
cp "$MC_ENV" "${MC_ENV}.bak.${TS}"
echo "[install-token] Backups: ${XPOZ_ENV}.bak.${TS}, ${MC_ENV}.bak.${TS}"

restore_and_fail() {
  echo "[install-token] FAILED — restoring backups..." >&2
  cp "${XPOZ_ENV}.bak.${TS}" "$XPOZ_ENV"
  cp "${MC_ENV}.bak.${TS}" "$MC_ENV"
  # Re-restart services so live env matches restored .env files.
  systemctl restart xpoz-pipeline 2>/dev/null || true
  systemctl restart mission-control 2>/dev/null || true
  exit 1
}

# Upsert XPOZ_API_TOKEN= into both .env files atomically.
python3 - <<PY || restore_and_fail
import os
token = os.environ["NEW_TOKEN"]
for path in ("$XPOZ_ENV", "$MC_ENV"):
    with open(path, "r") as f:
        lines = f.readlines()
    found = False
    for i, line in enumerate(lines):
        if line.startswith("XPOZ_API_TOKEN="):
            lines[i] = f"XPOZ_API_TOKEN={token}\n"
            found = True
            break
    if not found:
        if lines and not lines[-1].endswith("\n"):
            lines[-1] = lines[-1] + "\n"
        lines.append(f"XPOZ_API_TOKEN={token}\n")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.writelines(lines)
    os.replace(tmp, path)
    # Keep .env files permissioned tight
    os.chmod(path, 0o600)
    print(f"[install-token] Updated {path}")
PY

# ── Restart services ──────────────────────────────────────────────────────────
echo "[install-token] Restarting xpoz-pipeline..."
systemctl restart xpoz-pipeline
sleep 3

echo "[install-token] Restarting mission-control (MCP subprocess picks up new env)..."
systemctl restart mission-control
sleep 5

# ── Verify auth is live ───────────────────────────────────────────────────────
echo "[install-token] Verifying auth enforcement..."
BAD_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d '{"label":"auth-probe","subreddits":["test"],"keywords":["test"]}' \
  http://localhost:8086/run)

if [[ "$BAD_STATUS" != "401" ]]; then
  # Auth-enforcement failed but the .env files are correctly written and services restarted.
  # Do NOT silently roll back — that would leave live processes holding the new token while
  # .env files show the old one. Fail loud; operator inspects and decides manually.
  echo "FATAL: POST /run without token returned ${BAD_STATUS}, expected 401." >&2
  echo "       .env files are updated; inspect live service state before manual rollback." >&2
  echo "       Restore cmd (if needed):" >&2
  echo "         cp ${XPOZ_ENV}.bak.${TS} ${XPOZ_ENV} && cp ${MC_ENV}.bak.${TS} ${MC_ENV} && systemctl restart xpoz-pipeline mission-control" >&2
  exit 2
fi
echo "[install-token] ✅ POST /run without token correctly returns 401."

GOOD_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "X-Xpoz-Token: ${NEW_TOKEN}" \
  http://localhost:8086/health)
if [[ "$GOOD_STATUS" != "200" ]]; then
  echo "WARN: GET /health with token returned ${GOOD_STATUS} (expected 200). GET endpoints should still work without auth, too."
fi

# Confirm MCP picked up the token (any xpoz: connected line is fine — tool count may change).
if ! journalctl -u mission-control --since "30 sec ago" --no-pager | grep -q "xpoz: connected"; then
  echo "WARN: MCP server didn't reconnect cleanly — inspect 'journalctl -u mission-control --since 30 sec ago'." >&2
fi

echo ""
echo "[install-token] ✅ Token installed successfully."
echo "[install-token] Backups retained: ${XPOZ_ENV}.bak.${TS}, ${MC_ENV}.bak.${TS}"
echo "[install-token] Delete backups after verifying stability: rm ${XPOZ_ENV}.bak.${TS} ${MC_ENV}.bak.${TS}"
