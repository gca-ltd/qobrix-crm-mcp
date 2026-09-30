# Install Qobrix CRM MCP for Claude

This guide deploys the MCP Resource Server in oauth_user at:

- MCP: `https://intranet.sharpsir.group/qobrix-crm/mcp`
- OAuth issuer: `https://intranet.sharpsir.group/qobrix-crm/mcp-oauth`

The Node processes bind only to loopback. Apache provides public HTTPS.

## Prerequisites

- Node.js 20 or later
- npm
- pm2
- Apache 2.4 with `mod_proxy`, `mod_proxy_http`, `mod_headers`, and TLS
- The paired `qobrix-crm-mcp-oauth` repository
- A Qobrix tenant URL and valid Qobrix user credentials

## Build

```bash
cd /home/bitnami/qobrix-crm-mcp
npm ci
npm run build
```

The build copies the Sharp SIR logo into `dist/assets/`.

## Configure oauth_user

Generate secrets once:

```bash
openssl rand -hex 32  # shared introspection secret
openssl rand -hex 32  # MCP state secret
```

Create `.env` (never commit it):

```dotenv
QOBRIX_MCP_TRANSPORT=http
QOBRIX_MCP_AUTH=oauth_user
QOBRIX_MCP_HOST=127.0.0.1
QOBRIX_MCP_PORT=3502
QOBRIX_MCP_ALLOWED_HOSTS=intranet.sharpsir.group
QOBRIX_MCP_PUBLIC_URL=https://intranet.sharpsir.group/qobrix-crm
QOBRIX_MCP_RESOURCE_URL=https://intranet.sharpsir.group/qobrix-crm/mcp
QOBRIX_OAUTH_ISSUER=https://intranet.sharpsir.group/qobrix-crm/mcp-oauth
QOBRIX_OAUTH_INTROSPECTION_SECRET=<same-value-as-the-oauth-server>
QOBRIX_MCP_STATE_SECRET=<random-hex-value>
QOBRIX_MCP_DATA_DIR=./data/mcp-oauth
QOBRIX_CACHE_ENABLED=true
QOBRIX_CACHE_TTL=300
```

Set `.env` permissions to `600`.

## Run with pm2

Start the OAuth server first, then the MCP:

```bash
pm2 start /home/bitnami/qobrix-crm-mcp-oauth/dist/index.js \
  --name qobrix-crm-mcp-oauth \
  --cwd /home/bitnami/qobrix-crm-mcp-oauth \
  --interpreter node --node-args="--env-file=.env"

pm2 start /home/bitnami/qobrix-crm-mcp/dist/index.js \
  --name qobrix-crm-mcp \
  --cwd /home/bitnami/qobrix-crm-mcp \
  --interpreter node --node-args="--env-file=.env"

pm2 save
```

Local health check:

```bash
curl -fsS http://127.0.0.1:3502/health
```

## Apache reverse proxy

Add these directives to the TLS virtual host. Mount the OAuth AS
(`/qobrix-crm/mcp-oauth/`) **before** the MCP resource — `/qobrix-crm/mcp`
is a string prefix of `/qobrix-crm/mcp-oauth`, so AS-first ordering is
required for first-match-wins `ProxyPass`.

```apache
# Qobrix MCP OAuth AS — issuer /qobrix-crm/mcp-oauth (MUST precede /qobrix-crm/mcp)
ProxyPass /.well-known/oauth-authorization-server/qobrix-crm/mcp-oauth http://127.0.0.1:3503/.well-known/oauth-authorization-server
ProxyPassReverse /.well-known/oauth-authorization-server/qobrix-crm/mcp-oauth http://127.0.0.1:3503/.well-known/oauth-authorization-server
ProxyPass /.well-known/oauth-authorization-server http://127.0.0.1:3503/.well-known/oauth-authorization-server
ProxyPassReverse /.well-known/oauth-authorization-server http://127.0.0.1:3503/.well-known/oauth-authorization-server
ProxyPass /qobrix-crm/mcp-oauth/ http://127.0.0.1:3503/
ProxyPassReverse /qobrix-crm/mcp-oauth/ http://127.0.0.1:3503/

# Qobrix MCP resource (oauth_user). Listed after mcp-oauth so the longer AS
# prefix wins; /qobrix-crm/mcp is only reached for the MCP path.
ProxyPass /.well-known/oauth-protected-resource/qobrix-crm/mcp http://127.0.0.1:3502/.well-known/oauth-protected-resource/qobrix-crm/mcp
ProxyPassReverse /.well-known/oauth-protected-resource/qobrix-crm/mcp http://127.0.0.1:3502/.well-known/oauth-protected-resource/qobrix-crm/mcp
ProxyPass /qobrix-crm/mcp http://127.0.0.1:3502/mcp timeout=600 flushpackets=on
ProxyPassReverse /qobrix-crm/mcp http://127.0.0.1:3502/mcp

<Location "/qobrix-crm/mcp">
  SetEnv proxy-sendchunked 1
  Header set X-Accel-Buffering "no"
</Location>
```

### the signed-header path on path mounts (e.g. humaticai.com)

Planet 9 / ragchat the signed-header path uses separate public prefixes (`QOBRIX_MCP_PUBLIC_URL` /
`QOBRIX_OAUTH_ISSUER`), not the oauth_user `/qobrix-crm/mcp` paths above. Example:

```apache
# Browser-only MCP routes (deny /mcp + /health — agents use 127.0.0.1:3502)
RedirectMatch ^/qobrix-mcp$ /qobrix-mcp/
<LocationMatch "^/qobrix-mcp/(mcp|health)(/|$)">
    Require all denied
</LocationMatch>
<Location /qobrix-mcp/>
    ProxyErrorOverride Off
</Location>
ProxyPass        /qobrix-mcp/ http://127.0.0.1:3502/
ProxyPassReverse /qobrix-mcp/ http://127.0.0.1:3502/

# AS issuer path (strip prefix → Node sees /authorize, /token, …)
RedirectMatch ^/qobrix-oauth$ /qobrix-oauth/
<Location /qobrix-oauth/>
    ProxyErrorOverride Off
</Location>
ProxyPass        /qobrix-oauth/ http://127.0.0.1:3503/
ProxyPassReverse /qobrix-oauth/ http://127.0.0.1:3503/

# RFC 8414 path-issuer discovery (MCP must build with path-aware oauth-rs)
ProxyPass        /.well-known/oauth-authorization-server/qobrix-oauth http://127.0.0.1:3503/.well-known/oauth-authorization-server
ProxyPassReverse /.well-known/oauth-authorization-server/qobrix-oauth http://127.0.0.1:3503/.well-known/oauth-authorization-server
```

Exclude `/qobrix-mcp` and `/qobrix-oauth` from any SPA `RewriteRule` catch-all.
Rebuild and restart after pulling so `dist/` includes path-aware
`fetchAuthorizationServerMetadata` (issuer `https://host/qobrix-oauth` →
`/.well-known/oauth-authorization-server/qobrix-oauth`). A stale build that
discovers at bare `/.well-known/oauth-authorization-server` will parse marketing
SPA HTML and fail Sign In.

**Cookie Path trap:** never put `ProxyPassReverseCookiePath / /something` at
vhost scope — Apache treats `/` as a prefix of every path, so the signed-header path’s
`Path=/qobrix-mcp` connect cookie becomes `Path=/something` and the OAuth
callback fails with “Connect cookie / state mismatch”. Scope that directive
inside `<Location /eldes>` (or the app that needs it).

Validate and reload:

```bash
sudo /opt/bitnami/apache/bin/apachectl configtest
sudo /opt/bitnami/apache/bin/apachectl -k graceful
```

## Verify OAuth discovery

The unauthenticated MCP request must return `401` with a
`WWW-Authenticate` header containing the PRM URL:

```bash
curl -si -X POST \
  https://intranet.sharpsir.group/qobrix-crm/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
```

Verify the discovery documents:

```bash
curl -fsS \
  https://intranet.sharpsir.group/.well-known/oauth-protected-resource/qobrix-crm/mcp

curl -fsS \
  https://intranet.sharpsir.group/.well-known/oauth-authorization-server/qobrix-crm/mcp-oauth
```

The PRM `resource` must exactly match the MCP URL. Its first
`authorization_servers` entry must exactly match the OAuth issuer.

## Connect Claude

1. Open Claude.ai or Claude Desktop.
2. Go to **Settings → Connectors → Add custom connector**.
3. Enter `https://intranet.sharpsir.group/qobrix-crm/mcp`.
4. Select **Connect**.
5. Complete the Sharp Matrix Qobrix authorization form (endpoint, username,
   password, and 2FA when requested).
6. Approve access. Claude receives an audience-bound token and loads the tools.

If a WAF restricts source networks, allow Anthropic egress
`160.79.104.0/21`.

## Connect Cursor

Cursor and Claude share the **same** oauth_user MCP URL and Authorization Server.
Cursor’s Dynamic Client Registration sends **all three** redirect URIs; the AS
allowlist must prefix-match every one:

| Surface | Redirect URI | Allowlist prefix |
|---------|--------------|------------------|
| Desktop (custom scheme) | `cursor://anysphere.cursor-mcp/oauth/callback` | `cursor://` |
| Desktop (loopback) | `http://localhost:8787/callback` | `http://localhost` |
| Web / Agents | `https://www.cursor.com/agents/mcp/oauth/callback` | that exact URL |

A missing prefix makes `/register` reject the client. Older AS builds mapped
that to HTTP 500, which Cursor shows as **Internal Server Error**.

1. In Cursor: **Settings → MCP** (or `~/.cursor/mcp.json`).
2. Add a remote server (sibling of other `mcpServers` entries, not nested):

```json
"qobrix-crm-mcp": {
  "url": "https://intranet.sharpsir.group/qobrix-crm/mcp"
}
```

3. Reload MCP. Cursor will start OAuth; complete the Sharp Matrix Qobrix
   authorization form and approve.

## Connect Dust

Dust and Claude share the **same** oauth_user MCP URL and Authorization Server.
On the AS, keep Claude’s redirect prefix, Cursor’s HTTPS callback, and **append**
Dust finalize prefixes to `QOBRIX_OAUTH_REDIRECT_ALLOWLIST` (do not replace
Claude’s entry):

```bash
QOBRIX_OAUTH_REDIRECT_ALLOWLIST=https://claude.ai/api/mcp/auth_callback,https://eu.dust.tt/oauth/mcp/finalize,https://eu.dust.tt/oauth/mcp_static/finalize,http://127.0.0.1,http://localhost,cursor://,https://www.cursor.com/agents/mcp/oauth/callback
```

Dust docs: [Adding an MCP Server](https://docs.dust.tt/docs/user-documentation/admins/tools-management/adding-an-mcp-server).

### Preferred — Automatic (DCR)

1. In Dust: **Spaces → Tools → Add Tool → Add MCP Server**.
2. URL: `https://intranet.sharpsir.group/qobrix-crm/mcp` (same as Claude).
3. Auth: **Automatic**.
4. Connection: **Personal accounts** (each member logs into Qobrix as themselves).
5. Complete the Sharp Matrix Qobrix authorization form and approve.

### Fallback — Static OAuth

Use when Automatic is unavailable. Register a **new** Dust-only client (never
reuse or overwrite Claude clients in `clients.json`):

```bash
curl -fsS -X POST \
  https://intranet.sharpsir.group/qobrix-crm/mcp-oauth/register \
  -H 'Content-Type: application/json' \
  -d '{
    "client_name": "Dust MCP",
    "redirect_uris": ["https://eu.dust.tt/oauth/mcp_static/finalize"],
    "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code"],
    "token_endpoint_auth_method": "client_secret_post",
    "scope": "qobrix:read"
  }'
```

Fill Dust’s Static OAuth form:

| Field | Value |
|-------|--------|
| URL | `https://intranet.sharpsir.group/qobrix-crm/mcp` |
| Token endpoint | `https://intranet.sharpsir.group/qobrix-crm/mcp-oauth/token` |
| Authorization endpoint | `https://intranet.sharpsir.group/qobrix-crm/mcp-oauth/authorize` |
| Scope(s) | `qobrix:read` |
| Resource / Audience | `https://intranet.sharpsir.group/qobrix-crm/mcp` |
| Token endpoint auth | Request body (`client_secret_post`) |
| Client ID / Secret | From the register response above |

For Global (non-EU) Dust workspaces, use the matching
`dust.tt` / `app.dust.tt` `mcp_static` finalize URI instead of `eu.dust.tt`.

If a WAF restricts source networks, allow Dust egress **in addition to**
Anthropic `160.79.104.0/21` — do not remove Claude’s allowlist.

## Other authentication modes

`none`, `api_key`, and the signed-header path remain supported. See [USER_GUIDE.md](./USER_GUIDE.md) for
stdio shared credentials, trusted HTTP headers, and elicitation-based OAuth.
