#!/bin/sh
# Launcher for browserrenderer-mcp: stock @playwright/mcp, fail-closed config.
set -eu

APP_DIR="${BRMCP_APP_DIR:-/opt/browserrenderer-mcp}"
DATA_DIR="${BRMCP_DATA_DIR:-/var/lib/browserrenderer-mcp}"

BIND="${BRMCP_BIND:-127.0.0.1}"
PORT="${BRMCP_PORT:-8931}"
HOST_NAME="${BRMCP_HOSTNAME:-}"
MODE="${BRMCP_PROFILE_MODE:-isolated}"
EXE="${BRMCP_EXECUTABLE_PATH:-}"
NOSANDBOX="${BRMCP_NO_SANDBOX:-0}"
VIEWPORT="${BRMCP_VIEWPORT:-1440x900}"
NAV_TIMEOUT="${BRMCP_NAV_TIMEOUT:-30000}"
EXTRA="${BRMCP_EXTRA_ARGS:-}"

die() { echo "browserrenderer-mcp: ERROR: $*" >&2; exit 78; }

[ -n "$HOST_NAME" ] || die "BRMCP_HOSTNAME is empty. Set it in /etc/browserrenderer-mcp/browserrenderer-mcp.env and restart."
case "$HOST_NAME" in
  *'*'*) die "BRMCP_HOSTNAME must not contain '*'." ;;
  *[!A-Za-z0-9.,:_-]*) die "BRMCP_HOSTNAME contains invalid characters." ;;
esac
case "$MODE" in
  persistent|isolated) ;;
  *) die "BRMCP_PROFILE_MODE must be 'persistent' or 'isolated' (got '$MODE')." ;;
esac
case "$BIND" in
  *[!0-9.]*|'') die "BRMCP_BIND must be an IPv4 address (got '$BIND')." ;;
esac
case "$PORT" in
  ''|*[!0-9]*) die "BRMCP_PORT must be a number." ;;
esac
case "$NAV_TIMEOUT" in
  ''|*[!0-9]*) die "BRMCP_NAV_TIMEOUT must be milliseconds (got '$NAV_TIMEOUT')." ;;
esac
case "$NOSANDBOX" in 0|1) ;; *) die "BRMCP_NO_SANDBOX must be 0 or 1." ;; esac
VIEWPORT=$(printf '%s' "$VIEWPORT" | tr ',' 'x')
case "$VIEWPORT" in
  [0-9]*x[0-9]*) ;;
  *) die "BRMCP_VIEWPORT must look like 1440x900." ;;
esac

# Bundled Chromium location (see install-bundled-chromium).
PLAYWRIGHT_BROWSERS_PATH="$DATA_DIR/ms-playwright"
export PLAYWRIGHT_BROWSERS_PATH
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export HOME="${HOME:-$DATA_DIR}"

# Build argv safely: $@ holds the fixed args; EXTRA is intentionally word-split.
set -- --headless --browser chromium \
  --host "$BIND" --port "$PORT" \
  --allowed-hosts "$HOST_NAME" \
  --output-dir "$DATA_DIR/output" \
  --viewport-size "$VIEWPORT" \
  --timeout-navigation "$NAV_TIMEOUT" \
  --no-webmcp
if [ "$MODE" = persistent ]; then
  set -- "$@" --user-data-dir "$DATA_DIR/profile"
else
  set -- "$@" --isolated
fi
[ -z "$EXE" ] || set -- "$@" --executable-path "$EXE"
# Playwright disables the Chromium sandbox unless asked, so ask explicitly.
if [ "$NOSANDBOX" = 1 ]; then set -- "$@" --no-sandbox; else set -- "$@" --sandbox; fi
if [ -n "$EXTRA" ]; then
  # shellcheck disable=SC2086
  set -- "$@" $EXTRA
fi

exec node "$APP_DIR/node_modules/@playwright/mcp/cli.js" "$@"
