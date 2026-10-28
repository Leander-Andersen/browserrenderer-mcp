#!/bin/sh
# Reproducible build of dist/browserrenderer-mcp_<ver>_all.deb
set -eu
cd "$(dirname "$0")"
ROOT=$(pwd)
UPSTREAM=$(node -p "require('./package.json').dependencies['@playwright/mcp']")
REVISION=3
VERSION="$UPSTREAM-$REVISION"
DEB="dist/browserrenderer-mcp_${VERSION}_all.deb"

if SDE=$(git log -1 --format=%ct 2>/dev/null) && [ -n "$SDE" ]; then :; else SDE=1767225600; fi
export SOURCE_DATE_EPOCH="$SDE"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

STAGE="$ROOT/staging"
rm -rf "$STAGE"
mkdir -p "$STAGE/opt/browserrenderer-mcp/bin" "$STAGE/etc/browserrenderer-mcp" \
  "$STAGE/lib/systemd/system" "$STAGE/DEBIAN" "$STAGE/usr/share/doc/browserrenderer-mcp"

APP="$STAGE/opt/browserrenderer-mcp"
cp package.json package-lock.json "$APP/"
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund --ignore-scripts)
cp packaging/bin/start.sh packaging/bin/install-bundled-chromium "$APP/bin/"
cp packaging/etc/browserrenderer-mcp.env "$STAGE/etc/browserrenderer-mcp/"
cp packaging/systemd/browserrenderer-mcp.service "$STAGE/lib/systemd/system/"
cp README.md "$STAGE/usr/share/doc/browserrenderer-mcp/"
sed "s/@VERSION@/$VERSION/" packaging/debian/control > "$STAGE/DEBIAN/control"
cp packaging/debian/conffiles packaging/debian/postinst packaging/debian/prerm packaging/debian/postrm "$STAGE/DEBIAN/"

# Native module check: package is Architecture: all.
if find "$APP/node_modules" -name '*.node' -o -name binding.gyp | grep -q .; then
  echo "native modules found; Architecture must not be 'all'" >&2; exit 1
fi

# Normalise: drop npm's cache/metadata that varies, fix modes and mtimes.
rm -f "$APP/node_modules/.package-lock.json"
find "$STAGE" -type d -exec chmod 0755 {} +
find "$STAGE" -type f -exec chmod 0644 {} +
chmod 0755 "$APP/bin/start.sh" "$APP/bin/install-bundled-chromium" \
  "$STAGE/DEBIAN/postinst" "$STAGE/DEBIAN/prerm" "$STAGE/DEBIAN/postrm"
for f in "$APP"/node_modules/.bin/*; do [ -e "$f" ] && chmod 0755 "$f" || true; done
find "$STAGE" -exec touch -h -d "@$SDE" {} +

mkdir -p dist
rm -f "$DEB"
fakeroot dpkg-deb --build --root-owner-group -Zxz "$STAGE" "$DEB"
sha256sum "$DEB"
