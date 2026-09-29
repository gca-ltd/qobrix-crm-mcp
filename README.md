<p align="center">
  <a href="https://sharpsir.group">
    <img src="https://raw.githubusercontent.com/sharpsir-group/.github/main/brand/logo-blue.png" alt="SharpSir Group — Sharp Sotheby's International Realty brand logo" width="400" />
  </a>
</p>

<h1 align="center">Qobrix CRM MCP Server</h1>

<p align="center">
  <strong>Connect Claude.ai, Dust.tt, Cursor, and other MCP clients to your Qobrix real-estate CRM</strong> — listings, leads, viewings, offers, contracts, and activity in one read-only <a href="https://modelcontextprotocol.io/">Model Context Protocol</a> layer.<br />
  <strong>64 tools</strong> (CRM entities + AI relevance search + analytics + audit + cache controls + session/identity), <a href="https://www.reso.org/data-dictionary/">RESO Data Dictionary 2.0</a> workflows, optional <strong>Redis-backed response caching</strong>, <strong>four auth modes</strong> (stdio / headers / OAuth elicitation / remote MCP OAuth for <strong>Claude.ai</strong> and <strong>Dust.tt</strong>), and <strong>226+ automated tests</strong>.
</p>

<p align="center">
  <a href="https://github.com/gca-ltd/qobrix-crm-mcp">GitHub</a>
  ·
  <a href="https://qobrix.com/">Qobrix CRM</a>
  ·
  <a href="https://claude.ai/">Claude.ai</a>
  ·
  <a href="https://dust.tt/">Dust.tt</a>
  ·
  <a href="https://modelcontextprotocol.io/">MCP specification</a>
  ·
  <a href="https://www.reso.org/data-dictionary/">RESO DD 2.0</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white" alt="Built with TypeScript" />
  <img src="https://img.shields.io/badge/Node.js-339933?style=flat&logo=nodedotjs&logoColor=white" alt="Requires Node.js 20+" />
  <img src="https://img.shields.io/badge/MCP-000000?style=flat&logo=anthropic&logoColor=white" alt="Model Context Protocol" />
  <img src="https://img.shields.io/badge/Claude.ai-D97706?style=flat&logo=anthropic&logoColor=white" alt="Claude.ai custom connector supported" />
  <img src="https://img.shields.io/badge/Dust.tt-0F172A?style=flat&logoColor=white" alt="Dust.tt remote MCP supported" />
  <img src="https://img.shields.io/badge/Qobrix_CRM-4A90D9?style=flat&logoColor=white" alt="Qobrix CRM integration" />
  <img src="https://img.shields.io/badge/RESO_DD_2.0-1A1A2E?style=flat&logoColor=white" alt="RESO Data Dictionary 2.0" />
  <img src="https://img.shields.io/badge/Zod-3E67B1?style=flat&logo=zod&logoColor=white" alt="Zod schema validation" />
  <a href="https://github.com/gca-ltd/qobrix-crm-mcp/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue?style=flat" alt="Apache 2.0 license" /></a>
</p>

---

## Table of contents

- [**Installation Guide**](docs/INSTALL.md) — Sharp Matrix intranet, pm2, Apache, Claude.ai + Dust.tt connectors
- [**User Guide**](docs/USER_GUIDE.md) — Mode A → Mode B → Mode C → Mode D (Claude.ai + Dust.tt) step-by-step
- [What it does](#what-it-does)
- [Who it is for](#who-it-is-for)
- [Canonical real-estate workflows](#canonical-re-workflows)
- [Tools at a glance](#tools-at-a-glance)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Auth modes](#auth-modes)
- [Enterprise OAuth](#enterprise-oauth)
- [Caching](#caching)
- [Cursor IDE setup](#cursor-ide-setup)
- [Other MCP hosts](#other-mcp-hosts)
- [Search expression syntax](#search-expression-syntax)
- [Fetching related data](#fetching-related-data)
- [Testing](#testing)
- [Architecture](#architecture)
- [How the LLM learns](#how-the-llm-learns)
- [Technology](#technology)
- [License](#license)

---

### What It Does

An AI assistant connected to this server can browse properties, qualify leads, track showings, review offers and contracts, audit follow-up activity, and discover CRM field schemas — all through natural language. Every tool description teaches the LLM which canonical real-estate workflow it belongs to, which RESO resource it maps to, and which tools to chain next.

### Who it is for

- **Brokerages & developers** using [Qobrix](https://qobrix.com/) who want [Claude.ai](https://claude.ai/), [Dust.tt](https://dust.tt/), ChatGPT, or Cursor to answer questions grounded in live CRM data (not copy-pasted exports).
- **Engineers** wiring **MCP** into internal tools: stdio transport, typed Zod inputs, and no write surface — safe to experiment with prompts and agents.
- **Data & operations teams** running dashboards: use **`qobrix_count`** / **`qobrix_top_values`** for YoY-style metrics without custom scripts, and **response caching** to cut API load on repeat queries.
- **Enterprise IT** ready for per-agent identity: run Modes A/B from this package, then pair Mode C with SharpSir’s **Enterprise OAuth** (SSO) product when every user must authenticate as themselves — see [Enterprise OAuth](#enterprise-oauth).

### Canonical RE Workflows

The server is organized around six RESO-aligned business processes. The LLM receives these as built-in instructions so it can navigate the CRM without prior training.

| # | Workflow | RESO Mapping | Key Tools |
|---|----------|-------------|-----------|
| 1 | **Listing Lifecycle** | `Property.StandardStatus` | `search_properties`, `get_property`, `list_media`, `get_property_coordinates` |
| 2 | **Lead-Contact Lifecycle** | `Contacts.ContactType` funnel | `search_opportunities`, `get_contact`, `search_tasks` |
| 3 | **Sales Pipeline** | 8-stage buyer journey | `get_leads_by_property`, `get_lead_properties`, `list_viewings`, `list_offers`, `list_contracts` |
| 4 | **Showing / Viewing** | `ShowingAppointment` | `list_viewings`, `get_viewing`, `list_meetings` |
| 5 | **Transaction / Offer** | `TransactionManagement` | `list_offers`, `get_offer`, `list_contracts`, `get_contract` |
| 6 | **Activity / Follow-up** | Engagement tracking | `list_calls`, `list_meetings`, `list_email_messages`, `search_tasks` |

#### Status Mappings

| Qobrix Property Status | RESO StandardStatus |
|------------------------|---------------------|
| `available` | Active |
| `reserved` | Pending / Under Contract |
| `sold` | Closed |
| `withdrawn` | Withdrawn / Canceled |

| Qobrix Opportunity Status | RESO Lead Funnel |
|--------------------------|------------------|
| `new` | MQL / Raw Lead |
| `open` | SQL / Active |
| `won` | Closed Won |
| `closed_lost` | Lost |

---

### Tools at a Glance

**64** tools — CRM entities, schema discovery, **analytics** (`qobrix_count`, `qobrix_top_values`, `qobrix_top_records`, `qobrix_aggregate`), a flexible **deals** shortcut (`qobrix_deals`), **reporting** (`qobrix_timeseries`, `qobrix_funnel`, `qobrix_rep_scorecard`, `qobrix_stale_leads`, `qobrix_win_loss`, `qobrix_days_on_market`), **customer** intelligence (`qobrix_cohort`), **audit** / change history (`qobrix_get_changes`, `qobrix_search_changes`, `qobrix_field_change_history`, `qobrix_top_field_changers`), **cache** helpers (`qobrix_cache_stats`, `qobrix_cache_clear`), and **session & identity** (`qobrix_sign_in`, `qobrix_sign_out`, `qobrix_whoami`):

| Entity Group | Tools | Capabilities |
|-------------|-------|-------------|
| **Properties** | 5 | List, Get, Search, Coordinates (map), Properties-by-Lead |
| **Contacts** | 3 | List, Get, Search |
| **Agents** | 3 | List, Get, Search |
| **Opportunities / Leads** | 5 | List, Get, Search, Leads-by-Property, Lead-Properties |
| **Property Viewings** | 3 | List, Get, Search |
| **Tasks** | 3 | List, Get, Search |
| **Media** | 2 | List (with entity filter), Get (with size variants) |
| **Projects** | 4 | List, Get, Search, Coordinates |
| **Offers** | 3 | List, Get, Search |
| **Contracts** | 3 | List, Get, Search |
| **Calls** | 2 | List, Get |
| **Meetings** | 2 | List, Get |
| **Email Messages** | 2 | List, Get |
| **Schema / Meta** | 3 | Get Schema (field discovery), Get Field Options (enum values), Search DSL Help (full grammar + cheatsheets) |
| **Analytics** | 4 | Counts, top-N field values, full-scan top-N records by numeric/date, and sum/avg/min/max/count aggregates (with single- or multi-dim grouping). Prefer list/search `sort` for a single page; use top_records/aggregate for full-set scans or nullable fields |
| **Deals** | 1 | Flexible domain shortcut over the Contracts table (sales, rentals, listings, pipeline) with kind / contract_types[] / contract_statuses[] / date_field / min_price / party filters / summary block |
| **Reporting** | 6 | Time-series with YoY (`qobrix_timeseries`), canonical sales funnel + conversion % (`qobrix_funnel`), per-rep scorecard / agent leaderboard (`qobrix_rep_scorecard`), silent-lead detection (`qobrix_stale_leads`), win-rate analytics (`qobrix_win_loss`), days-on-market (`qobrix_days_on_market`) |
| **Customers** | 1 | Repeat-buyer / seller / lead cohorts (`qobrix_cohort`) — find contacts that appear on multiple closed deals or opportunities |
| **Audit** | 4 | Per-record change log (`qobrix_get_changes`), cross-resource change search (`qobrix_search_changes`), field-level history (`qobrix_field_change_history`), top field changers (`qobrix_top_field_changers`) |
| **Cache** | 2 | Stats and prefix or full invalidation for fresher reads |
| **Session & identity** | 3 | Interactive sign-in (`qobrix_sign_in`), full revoke sign-out (`qobrix_sign_out`), current user profile (`qobrix_whoami`) — Mode C; sensible no-ops in Modes A/B |

Every tool description includes its canonical workflow role, RESO equivalent, verified `include[]` options, FK resolution guidance, and search expression examples.

#### Analytics & Deals usage examples

Server-side `sort` (OpenAPI `sort[]`) works for most fields — e.g.
`sort: "-list_selling_price_amount"` on properties. Use **`qobrix_top_records`** /
**`qobrix_aggregate`** when you need a full-dataset scan, or when a nullable
field (e.g. `opportunities.budget`) returns no rows under server sort.
"Closed deals" don't live as a property flag — they're rows in the **Contracts**
table. The analytics/deals tools remove the need for client-side scripting:

```jsonc
// 1) Top 5 closed 2026 sales, sorted by final_selling_price_amount,
//    with property + agent + lawyers resolved to readable names.
{
  "tool": "qobrix_top_records",
  "args": {
    "resource": "contracts",
    "sort_by": "final_selling_price_amount",
    "search": "contract_type == \"cos\" and contract_status == \"agreed\" and date_of_contract >= \"2026-01-01\" and date_of_contract < \"2027-01-01\"",
    "top": 5
  }
}

// 2) 2026 sales volume, plus an agent leaderboard in one extra call.
{
  "tool": "qobrix_aggregate",
  "args": {
    "resource": "contracts",
    "field": "final_selling_price_amount",
    "op": "sum",
    "search": "contract_type == \"cos\" and contract_status == \"agreed\" and date_of_contract >= \"2026-01-01\" and date_of_contract < \"2027-01-01\"",
    "group_by": "commission_to_2",
    "top": 10
  }
}

// 3) Flexible "deals" shortcut — same answer as (1) with one default-laden call,
//    plus a full-set summary block (by_status, by_type, totals, median).
{ "tool": "qobrix_deals", "args": { "year": 2026, "top": 5 } }

// 4) Best 2026 rental contracts by final rental price.
{ "tool": "qobrix_deals", "args": { "kind": "rental", "year": 2026, "top": 5 } }

// 5) Under-contract reservations + closed sales together (pipeline + actuals).
{
  "tool": "qobrix_deals",
  "args": { "contract_statuses": ["reserved", "agreed"], "year": 2026 }
}

// 6) "My deals this year": uses the CURRENT_USER special var.
{
  "tool": "qobrix_deals",
  "args": { "assigned_to": "CURRENT_USER", "year": 2026 }
}

// 7) Monthly 2026 closed-sale volume with prior-year YoY %.
{
  "tool": "qobrix_timeseries",
  "args": {
    "resource": "contracts",
    "bucket": "month",
    "metric": "sum",
    "field": "final_selling_price_amount",
    "year": 2026,
    "search": "contract_type == \"cos\" and contract_status == \"agreed\"",
    "compare_to_prior": true
  }
}

// 8) Full 2026 sales funnel (Leads → Qualified → Viewing → Offer → Reserved → Closed).
{ "tool": "qobrix_funnel", "args": { "year": 2026 } }

// 9) 2026 agent leaderboard by volume (omit `user` for leaderboard mode).
{ "tool": "qobrix_rep_scorecard", "args": { "year": 2026, "sort_by": "volume", "top": 10 } }

// 10) Silent leads — open opportunities with no activity in 30 days.
{ "tool": "qobrix_stale_leads", "args": { "since_days": 30 } }

// 11) Multi-dim pivot: 2026 closed-sale volume by city × property_type.
{
  "tool": "qobrix_aggregate",
  "args": {
    "resource": "contracts",
    "field": "final_selling_price_amount",
    "op": "sum",
    "search": "contract_type == \"cos\" and contract_status == \"agreed\" and date_of_contract >= \"2026-01-01\" and date_of_contract < \"2027-01-01\"",
    "group_by": ["property_id", "contract_type"],
    "top": 10
  }
}

// 12) Repeat buyers — contacts behind 2+ closed sales in 2026.
{ "tool": "qobrix_cohort", "args": { "kind": "buyers", "year": 2026, "min_count": 2 } }

// 13) Win-rate by lead source in 2026, with top loss reasons resolved.
{
  "tool": "qobrix_win_loss",
  "args": { "year": 2026, "group_by": "source", "include_top_losses": true }
}

// 14) 2026 days-on-market by property type, with longest/shortest outliers.
{
  "tool": "qobrix_days_on_market",
  "args": { "kind": "sold", "year": 2026, "group_by": "property_type", "include_outliers": true }
}
```

---

### Quick Start

```bash
git clone https://github.com/gca-ltd/qobrix-crm-mcp.git
cd qobrix-crm-mcp
npm install
npm run build
```

### Configuration

Create a `.env` file in the project root:

```bash
QOBRIX_API_URL=https://yourcrm.qobrix.com
QOBRIX_API_USER=your-api-user-uuid
QOBRIX_API_KEY=your-api-key
QOBRIX_LOCALE=en-US          # optional
```

| Variable | Required | Description |
|----------|----------|-------------|
| `QOBRIX_API_URL` | Yes (Mode A) | Qobrix instance base URL |
| `QOBRIX_API_USER` | Yes (Mode A) | `X-Api-User` header value (UUID) |
| `QOBRIX_API_KEY` | Yes (Mode A) | `X-Api-Key` header value |
| `QOBRIX_LOCALE` | No | `X-Locale` header (e.g. `en-US`, `el-GR`) |

### Auth modes

Clone this package, run Mode A or B, and put live Qobrix data in front of Claude, Cursor, or any MCP client — Apache 2.0.

| Mode | In this package? | When | How credentials arrive |
|------|------------------|------|------------------------|
| **A** (default) | Yes | `QOBRIX_MCP_TRANSPORT=stdio` (or unset) | Shared `QOBRIX_API_*` from process env |
| **B** | Yes | `TRANSPORT=http` + `QOBRIX_MCP_AUTH=headers` | Per-request `X-Api-User` / `X-Api-Key` (trusted callers; bind localhost) |
| **C** | Needs companion AS | `TRANSPORT=http` + `QOBRIX_MCP_AUTH=oauth` | Self-service OAuth: MCP returns a `/connect` URL; user signs in at SharpSir’s **Enterprise OAuth** Authorization Server; this server holds the session |
| **D** (opt-in) | Needs companion AS | `TRANSPORT=http` + `QOBRIX_MCP_AUTH=oauth-claude` | Remote MCP OAuth (RFC 9728 PRM + Bearer on `/mcp`) for **Claude.ai** / Desktop custom connectors **and Dust.tt** Spaces tools — same resource URL, per-user login |

Modes A and B are fully supported out of this package. Modes C and D require SharpSir’s separate Enterprise OAuth / SSO product — not distributed as part of this repo. **Mode D does not change Modes A/B/C** — select it when you want remote hosts such as Claude.ai or Dust.tt to drive OAuth themselves.

### Enterprise OAuth

**Need the agent to work as a signed-in Qobrix user — not a shared API key?** Mode C is designed for that. It requires SharpSir’s **Enterprise OAuth solution**: a hosted Authorization Server bundle (login + 2FA + consent, per-user API-key minting, encrypted credential vault, audience-bound tokens) that pairs exclusively with this MCP server.

How Mode C works (MCP self-auth — northbound clients unchanged):

1. A tool runs with no session → the MCP returns an authorization URL:
   - **URL-mode elicitation** (`JSON-RPC -32042`) when the client supports `elicitation.url` (Claude, Cursor, etc.)
   - A Markdown **`[Sign In to Qobrix](/connect?e=…)`** link in the tool result for clients without elicitation (e.g. ragchat / LangChain) — the LLM must relay it verbatim (unique / single-use; never reuse an older link)
2. The user opens **`/connect`** on this server (anti-phishing indirection) → signed cookie + redirect to the Enterprise OAuth login page
3. After login + 2FA + consent, the AS redirects to **`/oauth/callback`**; this MCP exchanges the code (PKCE), introspects for Qobrix credentials, and stores them in an **encrypted session vault**
4. The next tool call runs authenticated. On Qobrix `401`/`403`, the vault is cleared and a fresh `/connect` URL is returned
5. Agents can also call **`qobrix_sign_in`**, **`qobrix_whoami`**, and **`qobrix_sign_out`** (full revoke via AS `/disconnect` + Qobrix API-key delete)

- Not available as a public download and **not** something you can clone from GitHub.
- Delivered and configured by our team **upon request** as an enterprise solution bundle.
- No third-party OAuth servers — Mode C is hard-wired to this Enterprise OAuth solution only.
- **Security:** Mode C uses **per-user encrypted session vaults** (keyed by
  chat identity headers) and leaves `/mcp` without a client bearer. Bind
  `QOBRIX_MCP_HOST=127.0.0.1` and set `QOBRIX_MCP_IDENTITY_SECRET` (shared only
  with the trusted MCP host like ragchat) so identity headers cannot be forged.
  Keep vault encryption on `QOBRIX_MCP_STATE_SECRET` (MCP-only). If you
  reverse-proxy for browsers, **publish only `/connect` and `/oauth/callback`**
  — deny public `/mcp` and `/health`. Local agents (ragchat) call
  `http://127.0.0.1:<port>/mcp`. When `ALLOWED_HOSTS` lists only the public
  hostname, loopback Host values (`127.0.0.1` / `localhost` / `::1`) are
  **auto-added** if the server binds to loopback. Connect cookie `Path`
  follows `PUBLIC_URL` pathname; Express `trust proxy` is `2` behind
  Cloudflare→Apache. Deliver `/connect` links only to the individual user —
  never into a shared/group thread.

**Ready to upgrade?** Contact [SharpSir Group](https://sharpsir.group) · [dev@sharpsir.group](mailto:dev@sharpsir.group) and ask for the **Qobrix CRM MCP Enterprise OAuth** bundle.

Once delivered, you point this server at the issuer you receive:

```bash
export QOBRIX_MCP_TRANSPORT=http
export QOBRIX_MCP_AUTH=oauth
export QOBRIX_MCP_HOST=127.0.0.1
export QOBRIX_MCP_PORT=3502
export QOBRIX_MCP_PUBLIC_URL=http://127.0.0.1:3502
export QOBRIX_MCP_RESOURCE_URL=http://127.0.0.1:3502/mcp
export QOBRIX_OAUTH_ISSUER=<issuer-from-enterprise-bundle>
export QOBRIX_OAUTH_INTROSPECTION_SECRET=<shared-secret-from-bundle>
export QOBRIX_MCP_STATE_SECRET=<16+-char-secret>
export QOBRIX_MCP_IDENTITY_SECRET=<16+-char-secret-shared-with-ragchat>
export QOBRIX_MCP_DATA_DIR=./data/mcp-oauth
export QOBRIX_MCP_ALLOWED_HOSTS=qobrix-mcp.example.com   # loopback Hosts auto-added when HOST is 127.0.0.1
npm start
```

Mode C endpoints (after the Enterprise OAuth solution is paired):

- `GET /connect?e=…` — start authorization (sets cookie, 302 to AS)
- `GET /oauth/callback` — PKCE code exchange + per-user session vault write
- `GET /health` — includes `connected` and `session_vaults` count
- Unauthenticated `/mcp` is intentional for northbound clients: tools surface the connect URL when needed — keep `/mcp` on **localhost** in production

See **[docs/USER_GUIDE.md](docs/USER_GUIDE.md)** for Mode A → B → C step-by-step, reverse-proxy lockdown, and Host allowlist details.

For **ragchat / Mode C**, register the remote MCP URL (`…/mcp`) as a normal Streamable HTTP server (**no client-side OAuth provider required**); the MCP handles auth via `/connect`. Keep `/mcp` on localhost in that topology.

#### Mode D — Claude.ai and Dust.tt remote MCP (shared resource)

Use a **separate** MCP process (or host) with `QOBRIX_MCP_AUTH=oauth-claude`. Remote hosts drive OAuth themselves against the same HTTPS `/mcp` URL:

| Host | How to connect | Auth |
|------|----------------|------|
| **[Claude.ai](https://claude.ai/) / Claude Desktop** | Settings → Connectors → Add custom connector | Automatic DCR + PKCE (redirect `https://claude.ai/api/mcp/auth_callback`) |
| **[Dust.tt](https://dust.tt/)** | Spaces → Tools → Add MCP Server | Prefer **Automatic**; Static OAuth fallback — see [INSTALL — Connect Dust](docs/INSTALL.md#connect-dust) |

1. User pastes `https://intranet.sharpsir.group/qobrix-crm/mcp` into Claude or Dust
2. Host hits `/mcp` → receives `401` + `WWW-Authenticate: Bearer resource_metadata=…`
3. Host fetches `/.well-known/oauth-protected-resource` → discovers `QOBRIX_OAUTH_ISSUER`
4. Host completes OAuth (DCR or Static) + PKCE against the Enterprise OAuth AS
5. Subsequent `/mcp` calls send `Authorization: Bearer <access_token>`; this server introspects and runs tools as that Qobrix user

Claude and Dust **share one Mode D stack** (same MCP resource + same Authorization Server). Each host registers its own OAuth client; each member logs into Qobrix as themselves.

```bash
export QOBRIX_MCP_TRANSPORT=http
export QOBRIX_MCP_AUTH=oauth-claude
export QOBRIX_MCP_HOST=127.0.0.1
export QOBRIX_MCP_PORT=3502
export QOBRIX_MCP_ALLOWED_HOSTS=intranet.sharpsir.group
export QOBRIX_MCP_PUBLIC_URL=https://intranet.sharpsir.group/qobrix-crm
export QOBRIX_MCP_RESOURCE_URL=https://intranet.sharpsir.group/qobrix-crm/mcp
export QOBRIX_OAUTH_ISSUER=https://intranet.sharpsir.group/qobrix-crm/mcp-oauth
export QOBRIX_OAUTH_INTROSPECTION_SECRET=<shared-secret-from-bundle>
npm start
```

On the AS, when using a redirect allowlist, keep Claude’s callback and append exact Dust finalize URLs (never replace Claude’s entry). Cursor also needs `https://www.cursor.com/agents/mcp/oauth/callback` in addition to `cursor://` (DCR sends both plus `http://localhost:8787/callback`):

```bash
export QOBRIX_OAUTH_REDIRECT_ALLOWLIST=https://claude.ai/api/mcp/auth_callback,http://127.0.0.1,http://localhost,cursor://,https://www.cursor.com/agents/mcp/oauth/callback,https://eu.dust.tt/oauth/mcp/finalize,https://eu.dust.tt/oauth/mcp_static/finalize,https://dust.tt/oauth/mcp/finalize,https://dust.tt/oauth/mcp_static/finalize,https://app.dust.tt/oauth/mcp/finalize,https://app.dust.tt/oauth/mcp_static/finalize
```

Publish **HTTPS `/mcp` + PRM** (and the AS) to the public internet; allowlist Anthropic egress `160.79.104.0/21` if WAF’d, and allow Dust egress in addition — do not remove Claude’s allowlist. Mode C’s loopback/`deny public /mcp` guidance stays valid for ragchat deployments — do not flip that topology for Mode C processes.

Full steps: [INSTALL — Connect Claude](docs/INSTALL.md#connect-claude) · [INSTALL — Connect Dust](docs/INSTALL.md#connect-dust) · [Dust: Adding an MCP Server](https://docs.dust.tt/docs/user-documentation/admins/tools-management/adding-an-mcp-server).

### Caching

All MCP tools are read-only `GET`s, so a response cache cannot corrupt CRM state. The server wraps **one chokepoint** (`QobrixClient.request()`) with a read-through cache, so **every** list/get/search/schema call — including each page of a relevance `max_scan` — is cached. Boost scoring is post-fetch and does not change the cache key, so re-ranking with different `boost[]` reuses the same candidate pages.

**Design — cache-aside with single-flight coalescing:**

- **Tier 1 — in-memory LRU** (always on, zero deps): per-process, TTL'd, size-capped.
- **Tier 2 — Redis** (optional, lazy-loaded via dynamic `import()`): set `QOBRIX_REDIS_URL` to enable; the server falls back to memory-only on any Redis error.
- **Single-flight**: when the LLM fires parallel tool calls that hit the same cold cache key (common with `qobrix_top_values`), all in-process callers share one upstream fetch.
- **Errors are never cached** — a transient 5xx will not get stuck.
- **TTL only**, no stale-while-revalidate in v1.

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `QOBRIX_CACHE_ENABLED` | `true` | Set to `false` to bypass the cache entirely |
| `QOBRIX_CACHE_TTL` | `300` | TTL in seconds; CRM edits visible within this window |
| `QOBRIX_CACHE_MAX_ENTRIES` | `5000` | LRU cap for the in-memory tier |
| `QOBRIX_REDIS_URL` | `(empty)` | `redis://` / `rediss://` URL; empty = memory only |
| `QOBRIX_REDIS_KEY_PREFIX` | `qobrix:` | Namespace when sharing a Redis instance |

**Cache tools (exposed to the LLM):**

| Tool | Use |
|------|-----|
| `qobrix_cache_stats` | Hits/misses/size/in-flight/Redis status — verify the cache is paying off |
| `qobrix_cache_clear` | Invalidate all keys or by `prefix` (e.g. `v1:request:opportunities`) for instant refresh before TTL |

**Recommended Redis server config** (for a dedicated cache-only Redis, per Redis docs):

```conf
maxmemory 256mb
maxmemory-policy allkeys-lru
maxmemory-samples 10
```

**TTL guidance** — Redis docs recommend short TTLs for frequently-changing data (60–120s) and longer for stable data (hours). 300s is a conservative default for a CRM that mixes lead pipeline (changes minutely) with property listings (changes hourly). Use `qobrix_cache_clear` when you need an instant refresh.

**Trade-off / known limit:** Single-flight coalescing is **in-process only**. Multi-instance deployments behind one shared Redis can still see modest stampede on cold keys; a distributed `SETNX` lock is future work and not needed for single-user MCP clients.

**Best-practices alignment:**

| Best practice | Where honored |
|---|---|
| Cache-aside / read-through (Redis docs, MCP caching guides) | `QobrixClient.request()` wrap |
| Canonical, versioned cache key | `cacheKey("v1", ...)` with sorted params |
| Conservative TTL | `300s` default, env-overridable |
| Errors not cached | Wrap stores only on resolved upstream success |
| Single-flight stampede prevention | In-process `inflight` map |
| `allkeys-lru` for cache-only Redis | Documented above for self-hosters |
| Observability + manual invalidation | `qobrix_cache_stats`, `qobrix_cache_clear` |
| Official Node.js Redis client | `redis` (node-redis), as `optionalDependencies` |

### Cursor IDE setup

Mode A is a local **stdio** process. Mode D is the hosted URL
`https://intranet.sharpsir.group/qobrix-crm/mcp` (same resource Claude and Dust
use). For Mode D, see [INSTALL — Connect Cursor](docs/INSTALL.md#connect-cursor).

This stdio path uses a local `node` process. Cursor discovers servers from
[project or user `mcp.json`](https://cursor.com/docs/mcp): `.cursor/mcp.json`
inside the folder you opened, or `~/.cursor/mcp.json` for all workspaces.

#### 1. Prerequisites

- **Node.js 20+** on the machine where Cursor runs the MCP (local laptop or remote SSH host).
- Clone this repo, install, and build (see [Quick Start](#quick-start)).
- **`dist/index.js` must exist** (`npm run build`) before adding the MCP entry.

#### 2. Credentials

1. Copy the template: `cp .env.example .env`
2. Edit `.env` and set at least `QOBRIX_API_URL`, `QOBRIX_API_USER`, and `QOBRIX_API_KEY` (see [Configuration](#configuration)).
3. Keep `.env` out of git; it is listed in `.gitignore`.

#### 3. Where to put the JSON

| Location | When to use |
|----------|----------------|
| **`<project>/.cursor/mcp.json`** | You opened that project folder in Cursor; teammates can commit a template (without secrets) or you keep it local-only. |
| **`~/.cursor/mcp.json`** | Same MCP on every workspace on that machine. |

Merge your entry into the existing `"mcpServers"` object; do not replace the whole file if you already have other servers.

#### 4. Recommended: `node --env-file` (Node 20+)

Pass **absolute paths** so it works the same whether the workspace root is this repo or a parent folder (and so SSH remote paths resolve correctly).

```json
{
  "mcpServers": {
    "qobrix-crm-mcp": {
      "command": "node",
      "args": [
        "--env-file=/absolute/path/to/qobrix-crm-mcp/.env",
        "/absolute/path/to/qobrix-crm-mcp/dist/index.js"
      ],
      "description": "Read-only Qobrix CRM MCP"
    }
  }
}
```

Why this pattern:

- Credentials stay in `.env`, not in JSON.
- Node loads the file **before** your server starts, so `process.env` is populated even when the host’s `envFile` field is ignored or behaves inconsistently for stdio servers.

#### 5. Alternative: inline `env`

Useful if you cannot use `--env-file` (older Node). **Secrets live in `mcp.json`** — restrict file permissions and do not commit them.

```json
{
  "mcpServers": {
    "qobrix-crm-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/qobrix-crm-mcp/dist/index.js"],
      "env": {
        "QOBRIX_API_URL": "https://yourcrm.qobrix.com",
        "QOBRIX_API_USER": "your-api-user-uuid",
        "QOBRIX_API_KEY": "your-api-key",
        "QOBRIX_LOCALE": "en-US"
      }
    }
  }
}
```

You can also use Cursor’s [config interpolation](https://cursor.com/docs/mcp) (for example `${env:QOBRIX_API_KEY}`) so values are injected from your OS environment instead of literals.

#### 6. Optional: `envFile` in MCP JSON

Cursor supports an `envFile` property for stdio servers. Some setups do not pass those variables into the child process reliably; if tools fail with “Missing required environment variables”, switch to **`--env-file`** as in step 4.

#### 7. After editing `mcp.json` or `.env`

1. **Reload MCP** — Command Palette → MCP restart, or reload the Cursor window.
2. **Check logs** — View → Output → pick **“MCP”** / **“MCP Logs”** in the dropdown; fix path or Node errors there.
3. **Tool approval** — By default Cursor asks before each tool call; you can allow auto-run for trusted tools in Cursor settings if you prefer.

### Other MCP hosts

**Claude.ai / Claude Desktop (Mode D)** — remote custom connector at `https://intranet.sharpsir.group/qobrix-crm/mcp`. See [Mode D](#mode-d--claudeai-and-dusttt-remote-mcp-shared-resource) and [INSTALL — Connect Claude](docs/INSTALL.md#connect-claude).

**Dust.tt (Mode D)** — Spaces → Tools → Add MCP Server with the **same** URL. Prefer Automatic auth and Personal accounts. See [INSTALL — Connect Dust](docs/INSTALL.md#connect-dust).

**Claude Desktop / Cursor (Mode A stdio)** — same stdio shape: `command` + `args` to `node` and either `--env-file` or `env` in the host’s MCP config file.

**CI / headless** — run `node --env-file=.env dist/index.js` with a stdio MCP client library; ensure `.env` is supplied via secrets, not committed.

---

### Search Expression Syntax

Tools that accept a `search` parameter use Qobrix's Symfony Expression Language (OpenAPI `SearchExpression`). Call **`qobrix_search_dsl_help`** for the full grammar + property/project field cheatsheets (optionally with live schema field names).

| Feature | Syntax | Example |
|---------|--------|---------|
| Equality | `==`, `!=`, `<>` | `status == "available"` |
| Comparison | `<`, `>`, `<=`, `>=` | `list_selling_price_amount <= 500000` |
| Contains | `contains`, `starts with`, `ends with` | `city contains "Limas"` |
| Set membership | `in [...]`, `not in [...]` | `property_type in ["villa","house"]` |
| Range | `in min..max` | `bedrooms in 2..4` |
| Logical | `and`, `or`, `not`, parentheses | `status == "available" and sale_rent == "for_sale"` |
| Date helpers | `DAYS_AGO(n)`, `MONTHS_AGO(n)`, `DAYS_FROM_NOW(n)`, … | `created >= DAYS_AGO(30)` |
| Time shortcuts | `NOW`, `TODAY`, `THIS_WEEK`, `LAST_MONTH`, `THIS_YEAR`, … | `created >= LAST_MONTH` |
| Current user | `CURRENT_USER` | `assigned_to == CURRENT_USER` |
| Geo / misc | `DISTANCE_FROM`, `IN_POLYGON`, `TRANSLATED`, `MIN`/`MAX` | `DISTANCE_FROM(coordinates, "34.43,32.13") <= 5000` |
| Association path | `Entity.field` | `SalespersonUsers.Contacts.country == "CY"` |

> **Tip:** Call `qobrix_search_dsl_help({ resource: "Properties" })` before composing free-language demand into a query. Use `qobrix_get_field_options` for enum values and `qobrix_get_schema` for the full field list.

### Relevant search on all resources (F1)

Every `qobrix_search_*` tool (properties, projects, contacts, agents, opportunities, viewings, tasks, offers, contracts) uses a **two-tier** design so free-language demand maps to high precision *and* high recall:

1. **`search`** — hard must-haves (server-side DSL filter → precision floor).
2. **`boost[]`** — soft weighted nice-to-haves scored in-process over a candidate pool (recall + ranking).
3. **`limit`** — how many ranked rows to return (default 10, max 100). Raise for more options; keep modest to avoid context overload.
4. **`max_scan`** — candidate pool when boosting (default 100, hard cap 500). Higher improves recall; each scanned page is **response-cached**.

With `boost`, each row includes `_relevance` (score) and `_matched` (which clauses hit); `pagination.mode` is `"ranked"`. Without `boost`, a single cached list page is returned (`mode: "fast"`).

```ts
qobrix_search_properties({
  search: 'status == "available" and sale_rent == "for_sale"',
  boost: [
    { field: "sea_view", op: "==", value: true, weight: 3 },
    { field: "bedrooms", op: ">=", value: 3, weight: 2 },
    { field: "list_selling_price_amount", op: "in", value: "200000..600000", weight: 2 },
  ],
  limit: 15,
  max_scan: 200,
});
```

#### Lead ↔ listing matching via search (2-way)

- **Demand → supply**: take a lead's criteria → `qobrix_search_properties` / `qobrix_search_projects` with `search`+`boost`. Native: `qobrix_get_properties_by_lead` / `qobrix_get_lead_properties`.
- **Supply → demand**: `qobrix_search_opportunities` with open-lead `search` + `boost` against the listing (works for **projects** too). Native for properties only: `qobrix_get_leads_by_property`.

```ts
// Who wants a Limassol 3-bed ~€400k listing?
qobrix_search_opportunities({
  search: 'status in ["new","open"] and buy_rent == "buy"',
  boost: [
    { field: "area_of_interest", op: "contains", value: "Limassol", weight: 3 },
    { field: "bedrooms_from", op: "<=", value: 3, weight: 2 },
    { field: "list_selling_price_to", op: ">=", value: 400000, weight: 2 },
  ],
  limit: 15,
  max_scan: 200,
});
```

Boost operators: `== != < > <= >= in contains starts_with ends_with`. For ranges use `op: "in"` with `value: "min..max"`.

Search (and every other list/get) shares the global cache TTL (`QOBRIX_CACHE_TTL`, default 300s). After CRM edits, refresh with `qobrix_cache_clear({ prefix: "v1:request:properties" })` (or `opportunities`, `projects`, …).

---

### Fetching Related Data

Three strategies to resolve foreign keys:

1. **`include[]` parameter** — expand associations inline in one call

```
qobrix_get_property({ id: "...", include: ["Agents", "PropertyViewings"] })
```

2. **Separate get call** — take the UUID from an FK field and call the appropriate tool

```
// property.agent → UUID
qobrix_get_agent({ id: "<agent-uuid>" })
```

3. **Search by FK** — find related records via search expression

```
qobrix_search_properties({ search: 'agent == "<agent-uuid>"' })
```

Only `include[]` values marked **Verified** in tool descriptions are guaranteed to work. When `include[]` is unavailable for an association, use search-by-FK.

---

### Payload defaults

To keep tool outputs short enough for the calling LLM's context window, list / search / get tools default to **compact** payloads:

| Param | Default | Effect when default |
|-------|---------|---------------------|
| `expand` | `false` | Foreign keys come back as **UUID strings** instead of being expanded into nested objects. Resolve them on demand with the matching get tool or with a targeted `include[]`. |
| `media`  | `false` | Inline media (photos, floor plans, thumbnail URLs) is **not** attached to list rows. Use `qobrix_list_media({ related_model: 'Properties', related_id: '<uuid>' })` when media is actually needed. |

Override per call only when the caller actually needs the heavier payload:

```ts
// Cheap browse — recommended for most reporting / pipeline calls
qobrix_list_properties({ limit: 10 });

// Heavy detail — only when the LLM truly needs nested FKs + media URLs
qobrix_list_properties({ limit: 5, expand: true, media: true });

// Prefer surgical include[] over full expand=true:
qobrix_get_property({ id: "...", include: ["AgentAgents", "ProjectProjects"] });
```

This change typically shrinks `qobrix_list_properties({ limit: 10 })` from ~300 KB to ~5–10 KB.

---

### Output cap

Every tool result is capped at `QOBRIX_MCP_MAX_RESULT_CHARS` characters of rendered JSON (default **30 000**, roughly 7.5 K tokens). Behaviour:

- **Paginated payloads** (`{ data: [...], pagination: {...} }`): truncated to the largest prefix of `data[]` that fits, and a `_truncated` block is attached with `kept_rows`, `omitted_rows`, `original_chars`, `max_chars`, and a `hint` telling the LLM how to scope the next call. If nested expand/media objects alone blow the cap, rows are **compacted to scalars** (`_truncated.compacted: true`) so at least one usable row is returned.
- **Grossly oversized** (default: original size `> 8 ×` the cap, override `QOBRIX_MCP_REFINE_MULTIPLIER`): returns `status: "result_too_large"` with `_refine_required` (assistant instruction + suggested narrowing + small `returned_sample`) so the LLM asks the user to reformulate — not dump.
- **Non-paginated payloads** (single `get`, custom analytic shapes): the JSON is clipped at the cap and a `QOBRIX_MCP TRUNCATED` trailer is appended (or the same refine directive when grossly oversized).

When `boost` is used with `expand=true` or `media=true`, `max_scan` is auto-capped at **100** and `pagination.scan_capped_reason` may be `"expand/media"`.

Override the cap / refine threshold:

```bash
QOBRIX_MCP_MAX_RESULT_CHARS=60000
QOBRIX_MCP_REFINE_MULTIPLIER=8
```

If you regularly hit the cap or refine guard, use `fields[]` (whitelist columns), a tighter `search` expression, a smaller `limit`, or keep `expand=false` / `media=false`.

---

### Testing

The project includes **226 automated tests** across **63** `describe` suites (integration, multi-step scenarios, RESO workflows, cache, relevance, output-cap, client-sort, and OAuth mode smoke):

```bash
# Integration tests — individual tool mechanics
npm test

# Scenario tests — multi-step tool chains (19 real-world scenarios)
npm run test:scenarios

# Workflow tests — canonical RE business processes (8 RESO-aligned suites)
npm run test:workflows

# Cache tests — read-through, single-flight, LRU eviction, search-page keys (no API needed)
npm run test:cache

# Relevance tests — boost scoring, DSL help, search cache keys (no API needed)
npm run test:relevance

# Format tests — output cap + truncation behaviour (no API needed)
npm run test:format

# OAuth modes smoke — Mode B header rejection + Mode C /connect elicitation path
npm run test:oauth-modes

# Run everything
npm run test:all
```

| Suite | Tests | Coverage |
|-------|-------|----------|
| Integration | 70 | Every tool, pagination edge cases, include/fields mechanics, analytics + reporting tools |
| Scenarios | 55 | Agent morning brief, buyer search, lead triage, FK chains, pipeline reports |
| Workflows | 39 | Listing lifecycle, lead funnel, sales pipeline, showing, transaction, media, activity, schema |
| Cache | 22 | Read-through cache, single-flight coalescing, LRU eviction, key canonicalization, search-page keys (no live API) |
| Relevance | 23 | Boost eval/score/rank (incl. opportunity/contact shapes), fields[]+boost union, DSL help text, search cache-key stability (no live API) |
| Format | 7 | `formatResult` output cap, paginated truncation, expand/media compaction (`kept_rows>=1`), `result_too_large` refine guard, fallback trailer, env override (no live API) |
| Client sort | 7 | `normalizeSort` + `buildQobrixUrl` emit OpenAPI `sort[]=` (not scalar `sort=` that Qobrix ignores) |
| OAuth modes | 4 | Mode B headers, Mode C `/connect`, Mode D PRM/401/Bearer |

---

### Architecture

```
src/
├── index.ts          # MCP server entry point + RESO workflow instructions
├── http.ts           # Streamable HTTP transport (Modes B / C)
├── modes.ts          # Auth mode resolution (env / headers / oauth / oauth-claude)
├── client.ts         # QobrixClient — HTTP + read-through response cache
├── auth-context.ts   # AsyncLocalStorage per-request credentials
├── oauth-client.ts   # Mode C self-service OAuth client + session vault
├── oauth-rs.ts       # Companion AS metadata + introspection helpers
├── request-context.ts# ALS for McpServer (elicitation capability detection)
├── cache.ts          # LRU memory tier, optional Redis, single-flight coalescing
├── relevance.ts      # Boost scoring + cached candidate pager for search
├── search-dsl.ts     # Full SearchExpression DSL reference + field cheatsheets
├── types.ts          # TypeScript interfaces
├── schemas.ts        # Zod schemas with rich LLM-facing descriptions
└── tools/
    ├── index.ts      # Tool registration hub + formatResult / errorResult
    ├── properties.ts # Listing Lifecycle + relevance search
    ├── contacts.ts   # Lead-Contact Lifecycle tools
    ├── agents.ts     # RESO Member tools
    ├── opportunities.ts # Sales Pipeline tools
    ├── viewings.ts   # Showing Lifecycle tools
    ├── tasks.ts      # Follow-up & Pipeline Management tools
    ├── media.ts      # Media Lifecycle tools
    ├── projects.ts   # Project/Development + relevance search
    ├── offers.ts     # Transaction Lifecycle tools
    ├── contracts.ts  # Transaction close tools
    ├── activities.ts # Activity Tracking (calls, meetings, emails)
    ├── analytics.ts  # qobrix_count, qobrix_top_values, qobrix_top_records, qobrix_aggregate
    ├── deals.ts      # qobrix_deals (flexible Contracts shortcut)
    ├── reports.ts    # qobrix_timeseries (bucketed metric + YoY), qobrix_days_on_market
    ├── pipeline.ts   # qobrix_funnel, qobrix_stale_leads, qobrix_win_loss
    ├── productivity.ts # qobrix_rep_scorecard
    ├── customers.ts  # qobrix_cohort (repeat buyers/sellers/leads)
    ├── cache.ts      # qobrix_cache_stats, qobrix_cache_clear
    ├── audit.ts      # change log / field history / top changers
    └── meta.ts       # Schema discovery + qobrix_search_dsl_help
test-suite/
├── integration.test.mjs  # Live API smoke tests
├── scenarios.test.mjs    # Multi-step CRM scenarios
├── workflows.test.mjs    # RESO workflow coverage
├── cache.test.mjs        # Cache unit tests (incl. search-page keys)
├── relevance.test.mjs    # Boost scoring + DSL help unit tests
├── format.test.mjs       # Output-cap / truncation tests
└── oauth-modes.test.mjs  # Mode B/C auth smoke tests
```

### How the LLM Learns

The server teaches the LLM at three levels:

1. **Server instructions** — top-level `instructions` field in the MCP `initialize` response provides the full data model, six canonical workflows with tool recipes, search syntax, FK resolution strategies, and known quirks.

2. **Tool descriptions** — each tool description includes its canonical workflow role, RESO equivalent, verified `include[]` options, FK field mappings, response shape, and search examples. Relevance search tools document the two-tier `search` + `boost` recipe; `qobrix_search_dsl_help` exposes the full DSL on demand.

3. **Parameter descriptions** — Zod schemas provide per-parameter help with concrete examples, valid enum values, and cross-tool references.

---

### Technology

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js ≥ 20 |
| Language | TypeScript 5.7 |
| MCP SDK | `@modelcontextprotocol/sdk` 1.26 |
| Validation | Zod 3.24 |
| Optional cache | `redis` 4.x (node-redis) when `QOBRIX_REDIS_URL` is set |
| Transport | stdio (default) · Streamable HTTP (Modes B / C) |
| API Auth | Mode A/B: `X-Api-User` + `X-Api-Key` · Mode C: self-service Enterprise OAuth (`/connect` URL) |
| Testing | Node.js built-in test runner (`node:test`) |

### License

[Apache License 2.0](LICENSE) — Copyright 2025–2026 SharpSir Group

Modes A and B are included in this open-source package. **Mode C** pairs with SharpSir’s **Enterprise OAuth** Authorization Server (SSO / per-user identity) — a separate commercial product delivered upon request — [sharpsir.group](https://sharpsir.group) · [dev@sharpsir.group](mailto:dev@sharpsir.group).

---

<p align="center">
  <sub>Part of the <a href="https://github.com/sharpsir-group"><strong>Sharp Matrix</strong></a> platform · <a href="https://sharpsir.group">sharpsir.group</a></sub>
</p>
