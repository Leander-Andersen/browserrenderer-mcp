#!/bin/sh
# Plain installer mirroring the .deb layout, for hosts without dpkg.
# Run as root from a checkout. Requires: node >= 18, npm, a chromium, systemd.
set -eu
cd "$(dirname "$0")"
[ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }
command -v node >/dev/null || { echo "node (>=18) is required." >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required." >&2; exit 1; }

APP=/opt/browserrenderer-mcp
ETC=/etc/browserrenderer-mcp
D=/var/lib/browserrenderer-mcp

mkdir -p "$APP/bin" "$ETC"
cp package.json package-lock.json "$APP/"
(cd "$APP" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --no-audit --no-fund --ignore-scripts)
install -m 0755 packaging/bin/start.sh packaging/bin/install-bundled-chromium "$APP/bin/"
[ -e "$ETC/browserrenderer-mcp.env" ] || install -m 0644 packaging/etc/browserrenderer-mcp.env "$ETC/"
install -m 0644 packaging/systemd/browserrenderer-mcp.service /etc/systemd/system/

getent group browserrenderer >/dev/null || groupadd --system browserrenderer
getent passwd browserrenderer >/dev/null || \
  useradd --system --gid browserrenderer --home-dir "$D" --no-create-home \
    --shell /usr/sbin/nologin browserrenderer
mkdir -p "$D/output" "$D/profile"
chown browserrenderer:browserrenderer "$D" "$D/output" "$D/profile"
chmod 0750 "$D" "$D/output" "$D/profile"

systemctl daemon-reload
systemctl enable browserrenderer-mcp.service
host=$(sed -n 's/^BRMCP_HOSTNAME=//p' "$ETC/browserrenderer-mcp.env" | tail -n 1 | tr -d ' "'"'")
if [ -z "$host" ]; then
  echo "BRMCP_HOSTNAME is not set. Edit $ETC/browserrenderer-mcp.env, then:" >&2
  echo "  systemctl restart browserrenderer-mcp" >&2
else
  systemctl restart browserrenderer-mcp.service
fi
echo "Note: install a browser yourself (e.g. apt install chromium fonts-liberation) or run $APP/bin/install-bundled-chromium."
