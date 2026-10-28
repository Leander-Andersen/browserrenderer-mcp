# browserrenderer-mcp

A Debian package that runs Microsoft's stock [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp)
(pinned, currently 0.0.83) as a hardened systemd service. No custom MCP code: only
packaging, config and a launcher. Intended for Debian 13 (trixie), bound to
`127.0.0.1` and fronted by a tunnel or reverse proxy. The MCP endpoint is
`http://127.0.0.1:<port>/mcp` (streamable HTTP).

## Build

Needs node/npm, `dpkg-deb`, `fakeroot`.

    ./build.sh        # -> dist/browserrenderer-mcp_0.0.83-1_all.deb

The build uses `npm ci` from the committed lockfile and `SOURCE_DATE_EPOCH` from the
last git commit.

## Install

    apt install ./browserrenderer-mcp_0.0.83-1_all.deb

Without dpkg: `./install.sh` (root, from a checkout). To expose it through
Cloudflare, `scripts/install-cloudflared.sh` adds the official apt repo and installs
`cloudflared`, plus `cloudflared-tunnel.service`, which reads the token from
`/etc/cloudflared/token` (root, 0600). Don't use `cloudflared service install <token>`:
it puts the token in the process cmdline. `browser_run_code_unsafe` is always on
upstream (RCE-equivalent), so the MCP unit hides other processes and `/etc/cloudflared`.
WebMCP page tools are off (`--no-webmcp`).

## Configure

Edit `/etc/browserrenderer-mcp/browserrenderer-mcp.env`, then
`systemctl restart browserrenderer-mcp`. `BRMCP_HOSTNAME` (the public hostname,
used for `--allowed-hosts`) is required: the service refuses to start without it.
Other options: port, `isolated|persistent` profile, browser path, sandbox toggle,
viewport, extra flags, listen address. The listen address defaults to `127.0.0.1`;
set `BRMCP_BIND=0.0.0.0` only when the tunnel connector runs on another host, and
firewall the port so only that host can connect.

## Update

1. Bump `@playwright/mcp` in `package.json` (exact version).
2. `npm install` to refresh `package-lock.json`.
3. Bump the Debian revision logic if needed (version is `<pin>-1`; change `REVISION` in `build.sh` for a rebuild of the same pin).
4. `./build.sh`, commit, reinstall the .deb.

## Debian chromium vs bundled chromium

By default the service uses Debian's `chromium` (`BRMCP_EXECUTABLE_PATH=/usr/bin/chromium`),
which gets security updates from apt. Playwright is tested against its own Chromium
build, so a much newer or older Debian chromium can occasionally misbehave. If so,
run `/opt/browserrenderer-mcp/bin/install-bundled-chromium` as root; it installs
the matching Chromium (with OS deps) via the vendored Playwright CLI into
`/var/lib/browserrenderer-mcp/ms-playwright` and prints the path to set as
`BRMCP_EXECUTABLE_PATH`. The bundled copy is not updated by apt.

## Security notes

- LAN isolation must be enforced at the firewall (egress rules). Playwright's
  `--allowed-origins`/`--blocked-origins` are explicitly not a security boundary
  (they do not cover redirects), so they are not used here.
- `--allowed-hosts` protects the MCP endpoint against Host-header/DNS-rebinding
  attacks; authentication (e.g. Cloudflare Access) must be done in front of it.
- The Chromium sandbox is on (`--sandbox`; Playwright's own default is off). It needs
  user namespaces. If Chromium cannot start sandboxed in your container, set `BRMCP_NO_SANDBOX=1`;
  that weakens isolation from hostile web pages, so rely on the container boundary.
