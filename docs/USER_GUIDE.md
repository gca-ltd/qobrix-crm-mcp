# User Guide — Qobrix CRM MCP

Connect [Claude.ai](https://claude.ai/), [Dust.tt](https://dust.tt/), Cursor, ChatGPT, PeerPane / ragchat, or any MCP client to live Qobrix CRM data.

**Package version:** see [`package.json`](../package.json) (currently **1.8.3**).
**Tools:** **64** MCP tools (entities, analytics, reporting, audit, cache, session/identity). Full list: [README — Tools at a Glance](../README.md#tools-at-a-glance).  
**Changelog:** [`CHANGELOG.md`](../CHANGELOG.md).

| Auth type | Transport | Credentials | Best for |
|-----------|-----------|-------------|----------|
| **none** (default) | stdio | Shared `QOBRIX_API_*` env | Local IDE, one shared CRM identity |
| **api_key** | HTTP | `Authorization: Bearer <user>:<key>`, or `X-Api-User` / `X-Api-Key` | Trusted private callers (localhost ragchat, internal services) |
| **signed-header** (legacy, needs Enterprise OAuth AS) | HTTP | Self-service OAuth (`/connect` → login) | ragchat / elicitation hosts; per-user vaults via `X-Chat-*` |
| **oauth_user** (needs Enterprise OAuth AS) | HTTP | Client OAuth (PRM + Bearer on `/mcp`) | **Claude.ai** / Desktop custom connectors **and Dust.tt** Spaces tools (shared resource URL) |

**Prerequisites:** Node.js **≥ 20**, a Qobrix tenant URL, and API credentials (`none` or `api_key`) or SharpSir’s **Enterprise OAuth** bundle (signed-header or `oauth_user`).

```bash
git clone https://github.com/gca-ltd/qobrix-crm-mcp.git
cd qobrix-crm-mcp
cp .env.example .env   # fill QOBRIX_API_* for none or api_key
npm install
npm run build
```

---

## Which mode do I want?

- **none** — Cursor / Claude Desktop **local** (stdio) for yourself with one service account.
- **api_key** — a trusted backend already holds Qobrix keys and can send them as headers on every `/mcp` call.
- **the signed-header path** — end user signs in via `/connect` (login + 2FA + consent) so tools run as that CRM user (ragchat / elicitation). Requires the proprietary **Enterprise OAuth** Authorization Server (delivered on request — [sharpsir.group](https://sharpsir.group) · [dev@sharpsir.group](mailto:dev@sharpsir.group)). Keep `/mcp` on localhost.
- **oauth_user** — remote MCP OAuth for **Claude.ai** / Desktop custom connectors **and Dust.tt** Spaces tools (paste HTTPS `/mcp` URL → Connect). Same Enterprise OAuth AS as the signed-header path; the host drives client OAuth (PRM + Bearer). Does **not** replace the signed-header path — run a separate process with `QOBRIX_MCP_AUTH=oauth_user`. Claude and Dust share one resource URL.

---

## none — stdio + shared API key

Simplest path. The MCP process reads credentials from the environment and speaks stdio to the host.

### 1. Configure `.env`

```bash
QOBRIX_API_URL=https://yourcrm.qobrix.com
QOBRIX_API_USER=your-api-user-uuid
QOBRIX_API_KEY=your-api-key
QOBRIX_LOCALE=en-US
# leave transport unset (default stdio) — none
```

### 2. Run

```bash
npm start
# → node dist/index.js  (stdio MCP)
```

### 3. Cursor (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "qobrix-crm": {
      "command": "node",
      "args": ["/absolute/path/to/qobrix-crm-mcp/dist/index.js"],
      "env": {
        "QOBRIX_API_URL": "https://yourcrm.qobrix.com",
        "QOBRIX_API_USER": "…",
        "QOBRIX_API_KEY": "…"
      }
    }
  }
}
```

### 4. Smoke test

Ask the agent: *“How many available properties are in the CRM?”* — it should call `qobrix_search_properties` / `qobrix_count` and return live numbers.

**Most expensive listing (and other ordered pages):** use list/search with
`sort: "-list_selling_price_amount"` (OpenAPI `sort[]`). For a full-inventory
top-N or nullable fields that return no rows under server sort, use
`qobrix_top_records` / `qobrix_aggregate` instead.

**Security:** none is a shared identity. Do not expose the stdio process over the network. (HTTP + `QOBRIX_MCP_AUTH=env` also exists in code for shared-env over HTTP — prefer api_key/C for multi-caller deployments.)

---

## api_key — HTTP + per-request headers

For trusted callers that already know the Qobrix credentials to use on each request. No OAuth. Env shared-key fallback is **disabled** — missing headers → error (no silent fall-back to `.env` API keys).

### 1. Configure and start

```bash
export QOBRIX_MCP_TRANSPORT=http
export QOBRIX_MCP_AUTH=headers
export QOBRIX_MCP_HOST=127.0.0.1
export QOBRIX_MCP_PORT=3502
export QOBRIX_LOCALE=en-US
npm start
```

### 2. Call `/mcp` with headers

| Header | Required | Purpose |
|--------|----------|---------|
| `X-Api-User` | Yes | Qobrix API user UUID |
| `X-Api-Key` | Yes | Qobrix API key |
| `X-Qobrix-Api-Url` | No | Override tenant URL for this request |
| `X-Locale` | No | Override locale |

```bash
curl -s http://127.0.0.1:3502/health
# {"ok":true,"transport":"http","auth":"headers",…}

curl -s -X POST http://127.0.0.1:3502/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "X-Api-User: $QOBRIX_API_USER" \
  -H "X-Api-Key: $QOBRIX_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

### 3. Wire from ragchat / PeerPane

Point a streamable-HTTP MCP server entry at `http://127.0.0.1:3502/mcp` and forward the caller’s Qobrix credentials as the headers above on each request.

**Security:** Bind to loopback (or a private network). api_key has no client OAuth — anyone who can reach `/mcp` and forge headers can act as that CRM user.

---

## the signed-header path — self-service Enterprise OAuth

The MCP becomes its **own** OAuth client and session holder. Northbound agents need **no** bearer wiring: when a tool needs auth, the MCP returns a `/connect` URL; the user signs in; the next tool call runs as that user.

Requires the proprietary companion **Enterprise OAuth** Authorization Server (delivered on request). Pairing secrets, login UI, vault, and HTTPS ops are documented in that package’s `docs/USER_GUIDE.md`.

### 1. Pairing env (Resource Server)

```bash
export QOBRIX_MCP_TRANSPORT=http
export QOBRIX_MCP_AUTH=oauth
export QOBRIX_MCP_HOST=127.0.0.1
export QOBRIX_MCP_PORT=3502

# Public HTTPS base (browser-facing /connect + /oauth/callback only)
export QOBRIX_MCP_PUBLIC_URL=https://qobrix-mcp.example.com
# Audience MUST include /mcp (do not omit — PUBLIC_URL fallback drops the path)
export QOBRIX_MCP_RESOURCE_URL=https://qobrix-mcp.example.com/mcp
# Public hostname(s) for Host checks. When HOST is loopback, 127.0.0.1 / localhost / ::1
# are auto-added so local agents (ragchat → http://127.0.0.1:3502/mcp) are not 403'd.
export QOBRIX_MCP_ALLOWED_HOSTS=qobrix-mcp.example.com

export QOBRIX_OAUTH_ISSUER=https://qobrix-oauth.example.com
export QOBRIX_OAUTH_INTROSPECTION_SECRET='<shared-long-secret>'
export QOBRIX_MCP_STATE_SECRET='<16+-char-secret>'   # cookies + vault encryption (MCP-only)
export QOBRIX_MCP_IDENTITY_SECRET='<16+-char-secret>' # signed X-Chat-* (shared with ragchat)
# chmod 600 the file that holds these secrets (ecosystem.config / .env)
export QOBRIX_MCP_DATA_DIR=./data/mcp-oauth          # persist across restarts
# Optional: QOBRIX_MCP_MAX_VAULTS=500  QOBRIX_MCP_VAULT_IDLE_MS=2592000000

# Local http:// issuer only (AS also auto-sets this for http: issuers):
# export MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL=true

npm start
```

Local loopback pairing (dev):

```bash
export QOBRIX_MCP_PUBLIC_URL=http://127.0.0.1:3502
export QOBRIX_MCP_RESOURCE_URL=http://127.0.0.1:3502/mcp
export QOBRIX_OAUTH_ISSUER=http://127.0.0.1:3503
export MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL=true
```

### 2. What the user sees in chat

the signed-header path stores a **per-user** encrypted vault keyed by the chat identity the
host forwards (`X-Chat-Platform` / `X-Chat-User-Id`, optionally signed with
`QOBRIX_MCP_IDENTITY_SECRET`). Teams/Telegram/WhatsApp/web each map to their
native individual id — signing in as Alice never overwrites Bob's vault.
Deliver the Sign In link **only to that individual** (never into a group thread).

1. Agent calls a CRM tool with no session for this user (or calls **`qobrix_sign_in`** / **`qobrix_whoami`**).
2. MCP returns either:
   - **URL-mode elicitation** (`JSON-RPC -32042`) when the client supports `elicitation.url`, or
   - A Markdown **`[Sign In to Qobrix]({PUBLIC_URL}/connect?e=…)`** link (ragchat / LangChain fallback). The LLM must show that exact link (unique / single-use — never reuse a link from an earlier message).
3. User opens `{PUBLIC_URL}/connect?e=…` → signed cookie → redirect to the AS login (Sharp Matrix–styled form: endpoint, username, password, optional 2FA, collapsible legal clickwrap).
4. AS redirects to `{PUBLIC_URL}/oauth/callback` → PKCE exchange + introspection → encrypted session vault (`session.enc`). The browser shows a **Connected** (or error) page in the same Sharp Matrix card shell as the login form, with a **Close** button — close the window and return to the chat to continue.
5. User retries — tools run with that user’s minted Qobrix API key.
6. **`qobrix_whoami`** returns the current profile (`user` + `capabilities` + `portals`, plus OAuth `subject` when available).
7. **`qobrix_sign_out`** fully revokes: AS `/disconnect` (Bearer) deletes the minted Qobrix API key and clears the AS vault/tokens, then the local vault is wiped. the signed-header path uses one shared vault — sign-out disconnects the shared identity for this MCP process.

### 3. Endpoints

| Path | Purpose | Public? |
|------|---------|---------|
| `GET /connect?e=…` | Start auth (cookie + 302 to AS) | Yes (browser) |
| `GET /oauth/callback` | Code exchange + vault write | Yes (browser) |
| `GET /health` | Liveness; the signed-header path includes `connected: true/false` | Prefer localhost only |
| `POST/GET/DELETE /mcp` | Streamable HTTP MCP (no client bearer in the signed-header path) | Prefer localhost only |

### 4. Gotchas (production)

- Always set **`QOBRIX_MCP_RESOURCE_URL`** to the full public `/mcp` URL.
- DCR `redirect_uri` must equal `{PUBLIC_URL}/oauth/callback` exactly (re-register / clear `DATA_DIR` client if you change the public URL).
- Persist **`QOBRIX_MCP_DATA_DIR`** (DCR client + session vault).
- **Single active session — one CRM identity per MCP process.** Whoever completes `/connect` last is the identity every tool call uses. Do not share one the signed-header path process across unrelated end users; use api_key for per-request isolation, or run one process per tenant/user.
- **`/mcp` has no client bearer.** Bind `QOBRIX_MCP_HOST` to loopback. If you reverse-proxy for browsers, **publish only `/connect` and `/oauth/callback`**; deny public `/mcp` and `/health` (e.g. Apache `Require all denied`). Agents such as ragchat must call `http://127.0.0.1:<port>/mcp` on the host.
- **Host allowlist:** set `QOBRIX_MCP_ALLOWED_HOSTS` to the public hostname. Loopback Host values are merged automatically when bind host is loopback — otherwise ragchat gets `403 Invalid Host: 127.0.0.1`.
- **Cookies:** connect cookie `Path` follows `QOBRIX_MCP_PUBLIC_URL` pathname (avoids reverse-proxy `ProxyPassReverseCookiePath` rewrites stealing `Path=/`).
- **Proxies:** Express `trust proxy` is **2** (Cloudflare → Apache → Node) so rate-limit IP keying is correct.
- Prefer **subdomain** URLs for the AS. Path mounts work when the AS issuer includes the path, login POST is relative, and well-known discovery is proxied carefully (see AS User Guide).
- Reference production (Sharp Matrix intranet): public oauth_user MCP at `https://intranet.sharpsir.group/qobrix-crm/mcp` with AS at `https://intranet.sharpsir.group/qobrix-crm/mcp-oauth`. See [INSTALL.md](./INSTALL.md).

### 5. Verify

```bash
curl -s http://127.0.0.1:3502/health
# {"ok":true,"auth":"oauth","connected":false,…}

# After a successful browser login:
curl -s http://127.0.0.1:3502/health
# {"ok":true,"auth":"oauth","connected":true,…}

# Local agent path must succeed without a custom Host header:
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3502/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"ragchat","version":"0"}}}'
# → 200
```

Automated smoke: `npm run test:oauth-modes`.

---

## oauth_user — Claude.ai and Dust.tt remote MCP (opt-in)

oauth_user is **additive**. It does not change none and api_key/C behavior. Remote hosts such as Claude.ai and Dust.tt require a `401` + `WWW-Authenticate` on the first unauthenticated `/mcp` call; the signed-header path intentionally returns `200` + a `/connect` URL there for ragchat — so remote-connector support lives in a separate auth mode.

**Supported oauth_user hosts (same MCP URL):**

| Host | Docs |
|------|------|
| [Claude.ai](https://claude.ai/) / Claude Desktop | [INSTALL — Connect Claude](./INSTALL.md#connect-claude) · [Claude connector authentication](https://claude.com/docs/connectors/building/authentication) |
| [Dust.tt](https://dust.tt/) | [INSTALL — Connect Dust](./INSTALL.md#connect-dust) · [Dust: Adding an MCP Server](https://docs.dust.tt/docs/user-documentation/admins/tools-management/adding-an-mcp-server) |

### 1. Configure a dedicated oauth_user process

```bash
export QOBRIX_MCP_TRANSPORT=http
export QOBRIX_MCP_AUTH=oauth_user
export QOBRIX_MCP_HOST=127.0.0.1
export QOBRIX_MCP_PORT=3502
export QOBRIX_MCP_ALLOWED_HOSTS=intranet.sharpsir.group
export QOBRIX_MCP_PUBLIC_URL=https://intranet.sharpsir.group/qobrix-crm
export QOBRIX_MCP_RESOURCE_URL=https://intranet.sharpsir.group/qobrix-crm/mcp
export QOBRIX_OAUTH_ISSUER=https://intranet.sharpsir.group/qobrix-crm/mcp-oauth
export QOBRIX_OAUTH_INTROSPECTION_SECRET=<same-secret-as-the-authorization-server>
npm start
```

Pair with the same Enterprise OAuth AS used for the signed-header path (`QOBRIX_MCP_RESOURCE_URL` on the AS must match this oauth_user resource URL exactly, including `/mcp`).

### 2. AS redirect allowlist (when enabled)

Keep Claude’s callback and append exact Dust finalize URLs (do not replace Claude’s entry).
Cursor DCR sends three redirect URIs — `cursor://…`, `http://localhost:8787/callback`,
and `https://www.cursor.com/agents/mcp/oauth/callback` — so the allowlist must include
the HTTPS Cursor callback as well as `cursor://` and `http://localhost`:

```bash
export QOBRIX_OAUTH_REDIRECT_ALLOWLIST=https://claude.ai/api/mcp/auth_callback,http://127.0.0.1,http://localhost,cursor://,https://www.cursor.com/agents/mcp/oauth/callback,https://eu.dust.tt/oauth/mcp/finalize,https://eu.dust.tt/oauth/mcp_static/finalize,https://dust.tt/oauth/mcp/finalize,https://dust.tt/oauth/mcp_static/finalize,https://app.dust.tt/oauth/mcp/finalize,https://app.dust.tt/oauth/mcp_static/finalize
```

Empty allowlist = allow all (default; the signed-header path local pairings keep working).

### 3. Publish HTTPS `/mcp` + PRM

| Path | Role | Public? |
|------|------|---------|
| `POST/GET/DELETE /mcp` | Streamable HTTP MCP (Bearer required) | **Yes** (Claude.ai, Dust.tt, and Cursor must reach it) |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 PRM → AS issuer | **Yes** |
| `GET /health` | Liveness | Prefer private |

**Path-prefix mounts are supported** when Apache proxies host-root well-known discovery correctly (RFC 9728 / RFC 8414 path-aware URLs). Sharp Matrix production:

| Public URL | Role |
|------------|------|
| `https://intranet.sharpsir.group/qobrix-crm/mcp` | oauth_user MCP resource |
| `https://intranet.sharpsir.group/qobrix-crm/mcp-oauth` | Paired OAuth AS issuer |
| `https://intranet.sharpsir.group/.well-known/oauth-protected-resource/qobrix-crm/mcp` | PRM |
| `https://intranet.sharpsir.group/.well-known/oauth-authorization-server/qobrix-crm/mcp-oauth` | AS metadata |

See [INSTALL.md](./INSTALL.md) for the exact Apache `ProxyPass` block. Subdomain deploys also work. Allowlist Anthropic egress `160.79.104.0/21` if the MCP/AS sit behind a WAF, and allow Dust egress **in addition** — never remove Claude’s allowlist. See [Claude connector authentication](https://claude.com/docs/connectors/building/authentication).

### 4. Connect in Claude.ai

1. Claude.ai or Claude Desktop → **Settings → Connectors → Add custom connector**
2. Paste `https://intranet.sharpsir.group/qobrix-crm/mcp`
3. Click **Connect** → complete Qobrix login + 2FA + consent on the Sharp Matrix OAuth AS
4. Tools appear under the connector; Claude refreshes tokens on `401`

### 5. Connect in Dust.tt

1. Dust → **Spaces → Tools → Add Tool → Add MCP Server**
2. URL: `https://intranet.sharpsir.group/qobrix-crm/mcp` (same as Claude)
3. Auth: **Automatic** (preferred) · Connection: **Personal accounts**
4. Complete Sharp Matrix Qobrix login + 2FA + consent
5. If Automatic is unavailable, use Static OAuth — see [INSTALL — Connect Dust](./INSTALL.md#connect-dust)

### 6. Verify

```bash
# Unauthenticated → 401 + WWW-Authenticate resource_metadata
curl -si -X POST https://intranet.sharpsir.group/qobrix-crm/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  | head -20

# PRM document
curl -s https://intranet.sharpsir.group/.well-known/oauth-protected-resource/qobrix-crm/mcp | jq .
```

the signed-header path’s guidance above (**deny public `/mcp`** for ragchat) remains correct for the signed-header path processes — do not apply oauth_user’s public `/mcp` topology to a the signed-header path instance.

---

## Caching & rate limits (optional)

- Caching: [README — Caching](../README.md#caching). Defaults: in-memory LRU; set `QOBRIX_REDIS_URL` for shared Redis. Related: `QOBRIX_CACHE_ENABLED`, `QOBRIX_CACHE_TTL`, `QOBRIX_CACHE_MAX_ENTRIES`, `QOBRIX_REDIS_KEY_PREFIX`.
- Rate limit: `QOBRIX_MCP_RATE_LIMIT` (default `300` req/min). the signed-header path also rate-limits `/connect` and `/oauth/callback` (`QOBRIX_MCP_OAUTH_RATE_LIMIT`, default `30`).
- Output cap: `QOBRIX_MCP_MAX_RESULT_CHARS` (default 30 000). Oversized results compact nested expand/media fields or return `status: "result_too_large"` with `_refine_required` so the agent asks the user to narrow the query. See README “Output cap”. `QOBRIX_MCP_REFINE_MULTIPLIER` (default 8) controls when refine escalates.

---

## Next steps

- Full tool list and RESO workflows: [README](../README.md)
- Enterprise OAuth sales / delivery: [sharpsir.group](https://sharpsir.group) · [dev@sharpsir.group](mailto:dev@sharpsir.group)
- Companion AS operations: `docs/USER_GUIDE.md` in the Enterprise OAuth delivery package
