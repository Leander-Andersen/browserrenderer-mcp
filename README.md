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
  frees the browser context. At `BRMCP_MAX_SESSIONS` (default 20) a new client evicts one idle
  session (not in flight, idle at least `BRMCP_SESSION_EVICT_IDLE_MS`, default 2 min; sessions that
  never used the browser first, then the least recently active), and only gets 503 when none
  qualifies. Clients such as claude.ai never close their sessions, so the cap would otherwise fill
  up. If the backend is down, `tools/list` still returns the
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

## Product lookup and price comparison

Two always-listed gateway tools read what elkjop.no, komplett.no, proshop.no and power.no
serve to any anonymous visitor (JSON-LD, the shops' own same-origin price/stock endpoints,
a few page elements). No logins, cookies or tricks; the browser's normal desktop user agent
(see Browser identity) is what the shops expect.

- `product_lookup {site, url|id|ean|query, mode?}`: one product. `mode` is `tldr` (name,
  model number, EAN, price, url), `normal` (default; adds brand, article number,
  before-price, campaign note, availability and stock) or `full` (adds up to 60 spec rows /
  4000 chars and a description of up to 600 chars). An `ean` or `query` that matches several
  products returns up to 5 candidates (article number, name, price, url) to pick from; an
  EAN match goes straight to the product.
- `product_compare {ean, sites?, mode?, prisjakt?}`: the same EAN on all (or the chosen) shops
  in one call: product, model, cheapest shop and one line per shop with price and stock
  (`mode=normal` adds before-price, stock detail and url). `prisjakt=true` adds one line with
  the Prisjakt lowest price and shop count.

Each call is ONE upstream `browser_run_code_unsafe` run of gateway-owned code
(`gateway/retail-page.mjs`); arguments are validated strictly first (`ean` 8-14 digits, `id`
4-10 digits, `query` up to 100 characters, `url` https on the shop's own host) and reach the
code only through `JSON.stringify`. Every shop is looked up in its own new tab (closed
afterwards; the current tab is never touched), in parallel, with a 25 s per-shop and 45 s
overall deadline: a slow or blocking shop yields a per-shop status (`blocked`, `timeout`,
`not found`, `error`) next to the shops that did answer. Roughly 1-3 page loads and 1-2
API calls per shop and call. The gateway log gets one line per shop (`retail site=elkjop
status=ok ms=2310`), never the EAN, query or URL. Specs are not available for power.no (its
specification panel has no public data source we could find). All of the output is untrusted
page data.

## Token footprint

The gateway trims what an LLM client has to read, without removing any upstream tool or
parameter (every upstream argument still works when sent):

- `browser_snapshot` returns a compact outline by default (`BRMCP_SNAPSHOT_MODE`, default
  `outline`); `mode=interactive` (optionally `urls=true`) lists controls with refs, `mode=full`
  the whole tree, capped by `max_chars` (default 20000). `target` or `depth` imply `full`.
  With `filename` the result passes through unchanged. Interactive mode takes optional filters:
  `roles` (any role names, e.g. `["heading","img"]`), `name` (case-insensitive substring) and
  `viewport=true` (only elements visible now); given without `mode` they imply interactive.
  Without a `name` filter, a role+name repeated 4+ times collapses to one line with a count and
  all its refs (first 60); with `urls=true` only items with the same URL collapse.
  The default outline of a page with fewer than 3 headings adds a `Text:` excerpt (about 600
  chars of visible text in document order) so such pages are not just counts.
- `browser_find` is searched in the gateway and returns one line per match (`link "x" [ref=e5] ->
  url`, `[in ref=...]` for ref-less text), capped by `max_chars` (`BRMCP_FIND_CHARS`, default
  6000). `detail=true` returns the stock output with ancestor context; `filename` passes through.
  The stock "Found N matches" counts matching lines, but snippets can hold several, so the gateway
  states both ("Found 29 matching lines in 28 snippets") and its cap note counts snippets. An
  ancestor path shared by the shown snippets is printed once as `Common path: ...`.
- Action results (navigate, click, ...) drop the `### Snapshot` link to a `.yml` file on the
  server, which a remote client cannot open.
- `browser_page_text` (gateway tool) reads visible text, optionally of a CSS `selector`, with
  `max_chars` (`BRMCP_PAGE_TEXT_CHARS`, default 8000) and `offset` for paging.
- `browser_take_screenshot` is downscaled and sent as JPEG by default (`resize`, default
  `BRMCP_SCREENSHOT_SCALE=60` percent), for the viewport, `fullPage` (cut at 10000 CSS px, the
  result text says so) and for one element (`target`: a ref or selector). An element smaller than
  90000 CSS px^2 is left at full size as PNG unless `resize` is given. `resize=1` and `filename`
  go to the stock tool unchanged (so does a `target` the gateway cannot resolve, such as a
  `getByRole(...)` expression; the stock tool then reports any error itself). An `element`
  argument without `target` is ignored (it only labels a target). Whenever the downscaled path
  cannot be used the gateway logs `gateway: screenshot fallback reason=<code>` (never arguments
  or content) and takes the stock path. `browser_run_code_unsafe` is a plain pass-through.
- Any text part longer than `BRMCP_MAX_RESULT_CHARS` (default 40000) is cut with a note.
- `BRMCP_CODEGEN` (default `none`) stops the backend echoing the Playwright code in results.
- Tool listings drop `$schema`, the descriptive `element` arguments, `additionalProperties`,
  annotation titles and annotation values equal to the MCP defaults, and verbose descriptions.
- Only the commonly used upstream tools are listed (`BRMCP_DIRECT_TOOLS`, see below); the rest
  (resize, close, console, network, emulate_media, file_upload, drop, drag, hover, and any
  upstream tool added later) sit behind one tool, `browser_more`. Its description names them.
  `browser_more {}` lists them with their arguments, `{tool}` returns one input schema and
  `{tool, args}` calls it (`args: {}` for none), with the same handling as a direct call. The
  size log line carries the real tool name (`call tool=browser_hover ...`). Calling a moved tool
  directly by name still works, and so does `browser_more` for a listed tool. The server
  instructions tell the model that a tool named in a result but not listed (e.g.
  `browser_file_upload` in a modal-state hint) is called through `browser_more`.
  The listing went from 30 tools / 19,357 chars to 21 tools / 10,952 chars.

Every tool call logs one size line (never arguments or content), for example:

    journalctl -u browserrenderer-gateway -g 'call tool=' -n 50
    gateway: call tool=browser_snapshot ms=412 text_chars=1873 images=0 image_b64_chars=0 raw_text_chars=47520 est_tokens=535 error=0

`list tools=<n> chars=<n>` is logged on every `tools/list`.

`BRMCP_DIRECT_TOOLS` (comma list of upstream tool names; default: navigate, navigate_back,
snapshot, find, click, type, fill_form, press_key, select_option, take_screenshot, evaluate,
wait_for, tabs, handle_dialog, run_code_unsafe) sets which upstream tools are listed directly.
`BRMCP_DIRECT_TOOLS=all` lists all of them and drops `browser_more` (30 tools, 14,921 chars; the
description trimming applies either way). `browser_page_text` and the watchlist/alert tools are
always listed.

## Version

The package has its own version (`package.json`, currently 0.1.0), independent of the pinned
`@playwright/mcp` version in its dependencies. The gateway reports it as its MCP server version.

## Build

Needs node/npm, `dpkg-deb`, `fakeroot`.

    ./build.sh        # -> dist/browserrenderer-mcp_0.1.0_all.deb (version from package.json)

The build uses `npm ci` from the committed lockfile and `SOURCE_DATE_EPOCH` from the
last git commit.

## Install

    apt install ./browserrenderer-mcp_0.1.0_all.deb

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
The file is a conffile, so edits survive upgrades and new settings are not added to it;
`/usr/share/doc/browserrenderer-mcp/browserrenderer-mcp.env.default` always lists every
current setting.
Other options: port, upstream (loopback) port, session idle timeout, session limit and eviction, `isolated|persistent`
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

## Browser identity

Headless Chromium announces itself as `HeadlessChrome` in its User-Agent header and
`navigator.userAgent`. Out of the box the service reports the normal Chromium user agent
instead (`HeadlessChrome` replaced by `Chrome`, version taken from the installed browser
at each start). Chromium's client hints (`Sec-CH-UA*`, `navigator.userAgentData`) already
name `Chromium`, not `HeadlessChrome`, and are left alone.

To present the same identity as your desktop browser, create
`/etc/browserrenderer-mcp/identity.json` (readable by the `browserrenderer` user, for
example `root:browserrenderer 0640`; change the path with `BRMCP_IDENTITY_FILE`) and restart.
`/usr/share/doc/browserrenderer-mcp/identity.example.json` is a generic starting point. All
fields are optional:

| Field | Effect |
|---|---|
| `userAgent` | User-Agent header and `navigator.userAgent` (printable ASCII, max 512) |
| `platform` | `navigator.platform` |
| `userAgentData` | `Sec-CH-UA`, `Sec-CH-UA-Mobile`, `Sec-CH-UA-Platform` headers and `navigator.userAgentData` (`brands`, `mobile`, `platform`, and `getHighEntropyValues()` from `fullVersionList`, `platformVersion`, `architecture`, `bitness`, `model`, `wow64`) |
| `languages` | `Accept-Language` header (with q-values) and `navigator.languages` / `language` (max 10 BCP47-style tags) |
| `timezone` | IANA zone, e.g. `Europe/Oslo` |
| `screen`, `viewport` | `{width, height}`, 100 to 10000. A `viewport` here wins over `BRMCP_VIEWPORT`; without one `BRMCP_VIEWPORT` applies |
| `deviceScaleFactor` | 0.5 to 4 |
| `colorScheme` | `light`, `dark` or `no-preference` |

The file is checked at every start; a malformed file stops the service with exit 78 and a
message in the journal (`BRMCP_IDENTITY_FILE` set to a missing file does too). The start
logs one line, `identity: source=file|default userAgent=...`, and nothing else from the file.

Notes and limits:

- Without `userAgentData` (or with `null`, as for Firefox and Safari) the file is taken to
  describe a browser without client hints: `navigator.userAgentData` is removed. Chromium
  still sends its own `Sec-CH-UA*` headers on HTTPS pages, which cannot be suppressed from
  config, so a non-Chromium user agent is only convincing for scripts, not for header checks.
- Client hints that sites request through `Accept-CH` (full version list, platform version,
  architecture, ...) are sent by Chromium itself; only `navigator.userAgentData` carries the
  file's values for those.
- `languages` sets the header and `navigator.languages`. The browser's `Intl` locale
  (number and date formatting) stays that of the host, because Playwright's locale override
  would replace the full `Accept-Language` list with a single tag.
- The overrides are installed by an init script (`navigator.platform`, `languages`,
  `userAgentData`) and request headers, so they apply to pages and iframes, not to web
  workers. Nothing else is changed: `navigator.webdriver`, plugins, canvas, WebGL, audio and
  fonts are untouched.
- The generated config and script are written to `/var/lib/browserrenderer-mcp/identity/`
  at each start.

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
