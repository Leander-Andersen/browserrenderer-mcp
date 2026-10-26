#!/bin/sh
# Add Cloudflare's official apt repository and install cloudflared.
# Run as root on Debian/Ubuntu. Installs a token-file unit; never handles the token.
set -eu
[ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }
apt-get update
apt-get install -y --no-install-recommends curl ca-certificates gnupg
mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  -o /usr/share/keyrings/cloudflare-main.gpg
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  > /etc/apt/sources.list.d/cloudflared.list
apt-get update
apt-get install -y cloudflared
cloudflared --version

# Token lives in a root-only file, never on the command line (see README).
install -d -m 0700 /etc/cloudflared
install -m 0644 "$(dirname "$0")/cloudflared-tunnel.service" /etc/systemd/system/cloudflared-tunnel.service
systemctl daemon-reload
systemctl enable cloudflared-tunnel.service
echo "Now write the tunnel token to /etc/cloudflared/token (mode 0600), then:"
echo "  systemctl start cloudflared-tunnel"
