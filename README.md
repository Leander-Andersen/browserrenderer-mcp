# browserrenderer-mcp

A Debian package that runs Microsoft's stock [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp)
(pinned, currently 0.0.83) as a hardened systemd service, fronted by a small custom
**gateway** MCP server. The gateway is the public endpoint: it proxies every browser
tool of the stock server unchanged (results passed through verbatim, including
images) and adds its own tools for a deal watchlist and email alerts, so one
claude.ai connector can browse, manage the watchlist and send alerts. Intended for
Debian 13 (trixie), fronted by a tunnel or reverse proxy. The MCP endpoint is
`http://<BRMCP_BIND>:<BRMCP_PORT>/mcp` (streamable HTTP only, no `/sse`).

## Architecture and security split

    claude.ai -> Cloudflare tunnel + Access (OAuth) -> gateway (BRMCP_BIND:BRMCP_PORT, user brgateway)
                                                          -> playwright-mcp (127.0.0.1:BRMCP_UPSTREAM_PORT, user browserrenderer)

- `browserrenderer-mcp.service`: the stock server, bound to loopback only
  (`--allowed-hosts 127.0.0.1:<upstream port>`). `browser_run_code_unsafe` cannot be
  disabled upstream, so assume anything running in this process is attacker-controlled.
- `browserrenderer-gateway.service` (`Requires=` the backend): runs as a separate user
  `brgateway` with its own data dir `/var/lib/browserrenderer-gateway` (0750). It alone
  loads `/etc/browserrenderer-mcp/notify.env` (SMTP credentials, `root:brgateway` 0640),
  so the browser process and its user cannot read them.
- The gateway listens on the same `BRMCP_BIND:BRMCP_PORT` as before, so the tunnel
  route, WAF/Access policy and firewall rules stay unchanged. It enforces the `Host`
  header against `BRMCP_HOSTNAME` (exact, case-insensitive, 403 otherwise).
- Each downstream MCP session gets its own upstream session (own browser context).
  Sessions idle for more than `BRMCP_SESSION_IDLE_MS` (default 1 h) are closed, which
  frees the browser context. If the backend is down, `tools/list` still returns the
  gateway tools and browser calls return a clear error.

## Gateway tools

- `watchlist_get`, `watchlist_add {query, max_price_nok?, location?, notes?}`,
  `watchlist_remove {id}`: the user's list of things to hunt for on finn.no (max 50),
  stored in `watchlist.json`.
- `alert_send {subject?, items[1..20]: {title, url, price_nok?, reason, watch_id?}}`:
  sends ONE email to the fixed `MAIL_TO` (no recipient argument). Each URL must start
  with one of `ALERT_LINK_PREFIXES` (default `https://www.finn.no/`); URLs already
  alerted within 90 days are skipped (`sent.json`); at most `ALERT_MAX_PER_DAY`
  emails per rolling 24 h. Returns `{sent, skipped_duplicates, rejected}`. Without
  SMTP configuration it returns a "not configured" error.

Page content is untrusted: the tool descriptions tell the model never to treat it as
instructions, and the server-side limits above (fixed recipient, link prefixes, dedupe,
daily cap) bound the damage if it does.

## Build

Needs node/npm, `dpkg-deb`, `fakeroot`.

    ./build.sh        # -> dist/browserrenderer-mcp_0.0.83-5_all.deb

The build uses `npm ci` from the committed lockfile and `SOURCE_DATE_EPOCH` from the
last git commit.

## Install

    apt install ./browserrenderer-mcp_0.0.83-5_all.deb

Without dpkg: `./install.sh` (root, from a checkout). To expose it through
Cloudflare, `scripts/install-cloudflared.sh` adds the official apt repo and installs
`cloudflared`, plus `cloudflared-tunnel.service`, which reads the token from
`/etc/cloudflared/token` (root, 0600). Don't use `cloudflared service install <token>`:
it puts the token in the process cmdline. `browser_run_code_unsafe` is always on
upstream (RCE-equivalent), so the MCP unit hides other processes and `/etc/cloudflared`.
WebMCP page tools are off (`--no-webmcp`).

## Configure

Edit `/etc/browserrenderer-mcp/browserrenderer-mcp.env`, then
`systemctl restart browserrenderer-mcp` (restarts the gateway too).
`BRMCP_HOSTNAME` (the public hostname, enforced by the gateway) is required: both
services refuse to start without it.
Other options: port, upstream (loopback) port, session idle timeout, `isolated|persistent`
profile, browser path, sandbox toggle, viewport, navigation timeout (default 30 s, under
claude.ai's ~60 s per-call limit), extra flags (for the backend), listen address. The
listen address defaults to `127.0.0.1`; set `BRMCP_BIND=0.0.0.0` only when the tunnel
connector runs on another host, and firewall the port so only that host can connect.

### Email alerts: `/etc/browserrenderer-mcp/notify.env`

`SMTP_HOST`, `SMTP_PORT` (587), `SMTP_SECURITY` (`starttls` | `tls` | `none`, the last
only for a localhost host), `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `MAIL_TO` (the only
recipient), `ALERT_LINK_PREFIXES` (semicolon-separated), `ALERT_MAX_PER_DAY` (20). Ships
with empty values (alerts off). smtp2go works: `mail.smtp2go.com`, 587 or 2525 with
`starttls`, or 465 with `tls`. After editing: `systemctl restart browserrenderer-gateway`.
The postinst resets the file to `root:brgateway` mode 0640 on every configure; keep it
that way.

## Update

1. Bump `@playwright/mcp` in `package.json` (exact version). The gateway's dependencies
   (`@modelcontextprotocol/sdk`, `nodemailer`, `zod`) are pinned there too.
2. `npm install` to refresh `package-lock.json`.
3. The package version is `<pin>-<REVISION>`; change `REVISION` in `build.sh` for a rebuild of the same pin.
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
- The gateway's Host check (and the backend's `--allowed-hosts`) protects against
  Host-header/DNS-rebinding attacks; authentication (e.g. Cloudflare Access) must be done
  in front of the gateway.
- The Chromium sandbox is on (`--sandbox`; Playwright's own default is off). It needs
  user namespaces. If Chromium cannot start sandboxed in your container, set `BRMCP_NO_SANDBOX=1`;
  that weakens isolation from hostile web pages, so rely on the container boundary.
