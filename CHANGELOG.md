# Changelog

All notable changes to the **Qobrix CRM MCP server** are documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.8.3] - 2026-08-10

### Added

- **Claude.ai + Dust.tt on one Mode D stack.** Documented connecting
  [Claude.ai](https://claude.ai/) custom connectors and [Dust.tt](https://dust.tt/)
  Spaces MCP tools to the same public resource
  (`https://intranet.sharpsir.group/qobrix-crm/mcp`) and Authorization Server.
  Prefer Dust Automatic DCR; Static OAuth is documented as a fallback.
- `docs/INSTALL.md` **Connect Dust** section; README / USER_GUIDE Mode D updated
  for both hosts. Redirect allowlist examples use exact Dust finalize URLs and
  never drop Claude’s callback.

### Compatibility

- Modes A–D unchanged. Existing Claude.ai connectors keep working on the same
  URL while Dust is added as a second Mode D client.

---

## [1.8.2] - 2026-07-24

### Fixed

- **Docs:** Mode C path-mount Apache recipe (`/qobrix-mcp` + `/qobrix-oauth` +
  RFC 8414 discovery) so Planet 9 Sign In does not fall through to a marketing
  SPA. Notes that a stale `dist` without path-aware AS discovery fails the same
  way. Warns that vhost-wide `ProxyPassReverseCookiePath / /…` rewrites the
  Mode C connect cookie Path and breaks OAuth callback (“cookie / state mismatch”).


## [1.8.1] - 2026-07-24

### Changed

- Mode D public resource URL renamed to
  `https://intranet.sharpsir.group/qobrix-crm/mcp` (AS issuer
  `https://intranet.sharpsir.group/qobrix-crm/mcp-oauth`).
- Callback page footer entity is now G.C.A. Global Citizen Advisory Limited.
- `docs/INSTALL.md` Apache block uses AS-first `ProxyPass` ordering so
  `/qobrix-crm/mcp` does not shadow `/qobrix-crm/mcp-oauth`.

### Compatibility

- Modes A, B, and C are unchanged. Mode D remains opt-in; only the public
  path prefix changed.

---

## [1.8.0] - 2026-07-24

### Added

- Production Mode D deployment at
  `https://intranet.sharpsir.group/qobrix-crm/mcp`, paired with the
  path-prefixed Sharp Matrix OAuth issuer.
- Path-aware RFC 8414 Authorization Server discovery for issuers mounted below
  the host root.
- `docs/INSTALL.md` with pm2, Apache, OAuth discovery, and Claude connector
  instructions.
- Sharp Matrix–styled success and error pages with embedded Sharp SIR branding.

### Changed

- Removed legacy third-party branding and external logo dependencies.
- Build now copies the Sharp SIR logo to `dist/assets/`.

### Compatibility

- Modes A, B, and C are unchanged. Mode D remains opt-in.

---

## [1.7.1] - 2026-07-24

### Fixed

- **Mode D introspection cache**: `createCompanionTokenVerifier` now caches
  successful introspections (sha256 token key, TTL `min(30s, exp−skew)`, LRU
  512). Prevents AS `/introspect` 30/min storms that turned into Claude 401
  re-auth loops under tool-call load. Failures/inactive tokens are never cached.
- Docs clarified the requirements for Mode D path-prefix mounts.

### Compatibility

- Modes A/B/C unchanged. Cache is only used by Mode D Bearer verification.

---

## [1.7.0] - 2026-07-24

### Added

- **Mode D (opt-in) — Claude.ai / Desktop remote custom connector**: select with
  `QOBRIX_MCP_AUTH=oauth-claude` (aliases `claude`, `d`). Serves RFC 9728
  Protected Resource Metadata, returns `401` + `WWW-Authenticate:
  Bearer resource_metadata=…` on unauthenticated `/mcp`, and validates
  `Authorization: Bearer` via companion AS introspection.
- PRM routes (Mode D only): `/.well-known/oauth-protected-resource` and
  path-aware `/.well-known/oauth-protected-resource/mcp`.
- Docs: Claude.ai connector runbook (additive); Modes A/B/C unchanged.

### Compatibility

- Modes A, B, and C are **byte-for-byte unchanged**. Mode C still answers
  unauthenticated `/mcp` with **200 + `/connect` URL** (elicitation). Claude
  requires a **401** on that same call — hence a separate opt-in mode, not a
  patch to Mode C. Existing deployments keep working unless an operator
  explicitly sets `QOBRIX_MCP_AUTH=oauth-claude`.

---

## [1.6.1] - 2026-07-13

### Fixed

- **Proactive refresh no longer wipes valid vaults**: at 80% access-token TTL a
  transient AS failure (`5xx`, network blip) previously called `clearSession`
  and forced every active user to re-auth. Refresh now clears only on
  `invalid_grant` or when the access token is already past skew; otherwise the
  vault is kept and Qobrix `401/403` remains the authoritative clear path.

### Changed

- Vault eviction is throttled to ~once/60s (immediate when over `MAX_VAULTS`).
- `/health` `connected` tracks `session_vaults > 0` (not only the `default` vault).
- Per-request vault audit stderr is gated behind `QOBRIX_MCP_DEBUG=1`; forged
  identity warnings still always log.

---

## [1.6.0] - 2026-07-13

### Added

- **Per-user Mode C session vaults**: encrypted vaults under `data/mcp-oauth/sessions/`
  keyed by chat identity (`{platform}:{userId}` from `X-Chat-Platform` /
  `X-Chat-User-Id`). Each human (Teams AAD oid, Telegram user id, WhatsApp
  phone, web user id) has an isolated Qobrix login — last-login-wins is gone.
- **Signed identity assertion**: optional `QOBRIX_MCP_IDENTITY_SECRET` (16+)
  verifies `X-Chat-Identity-{Iat,Exp,Sig}` so a forged user-id header cannot
  select another vault. Dedicated secret — separate from vault-encryption
  `QOBRIX_MCP_STATE_SECRET`.
- Per-vault DEK via HKDF; atomic vault writes; per-vault refresh mutex with
  proactive refresh at ~80% access-token TTL; idle/LRU vault eviction
  (`QOBRIX_MCP_MAX_VAULTS`, `QOBRIX_MCP_VAULT_IDLE_MS`).
- `/health` reports `session_vaults` count; audit logs use a hashed vault key.

### Changed

- Legacy single-slot `session.enc` migrates into the `default` vault on first use.
- `qobrix_sign_in` / `qobrix_sign_out` / `qobrix_whoami` operate on the current
  request's vault only. Deliver `/connect` links only to the individual — never
  into a shared/group thread.
- Mode C docs: pin `/mcp` to loopback, set identity secret, chmod secrets to 600.

### Security

- Rotating `QOBRIX_MCP_IDENTITY_SECRET` invalidates in-flight signed headers only
  (no user re-auth). Rotating `QOBRIX_MCP_STATE_SECRET` invalidates all vaults
  and connect cookies (users re-auth). Never log either secret or full connect URLs.

---

## [1.5.3] - 2026-07-12

### Changed

- Mode C `/oauth/callback` success and error pages now use the same Sharp Matrix
  card shell as the Enterprise OAuth login page (logo, Qobrix brand row,
  background). Primary **Close** button calls `window.close()`; if the browser
  blocks it, a muted hint asks the user to close manually and return to chat.

---

## [1.5.2] - 2026-07-12

### Fixed

- **Server-side `sort` was silently dropped**: the OpenAPI spec defines the query
  param as `sort[]` (array), but the client sent scalar `sort=…`. Qobrix ignored
  the unknown key and returned default order — so "most expensive listing" and
  similar queries looked broken. The client now emits `sort[]=` via
  `normalizeSort()` (string / comma-separated / string[] all work).

### Changed

- Docs/tool descriptions no longer claim that `sort` is "silently ignored" on
  calculated numeric fields. Prefer list/search `sort='-field'` for a page;
  keep `qobrix_top_records` / `qobrix_aggregate` for full-dataset scans and
  nullable fields (e.g. `opportunities.budget`) that can return no rows under
  server sort.

### Docs

- README / CHANGELOG / GitHub About no longer use freemium/PLG framing. Modes A/B
  ship in this open-source package; Mode C pairs with SharpSir’s separate
  **Enterprise OAuth** (SSO) product upon request — not an upsell path described
  as product-led growth.

---

## [1.5.1] - 2026-07-12

### Fixed

- **`formatResult` truncation cliff**: when every expanded/media row alone exceeded
  `QOBRIX_MCP_MAX_RESULT_CHARS`, binary search kept `0` rows and returned
  `data: []`. Rows are now re-rendered **scalar-only** (nested expand/media
  dropped), at least one row is always kept, and `_truncated.compacted: true`
  is set.
- **Expensive expand/media scans**: with `boost` + `expand`/`media`, `max_scan`
  is auto-capped at **100** (was hard-capped only at 500). Pagination may
  include `scan_capped_reason: "expand/media"`.

### Added

- **Response-size refine guard**: when a payload is grossly oversized
  (default `> 8 ×` the char cap, override `QOBRIX_MCP_REFINE_MULTIPLIER`) or
  compaction still cannot fit a usable page, tools return
  `status: "result_too_large"` with `_refine_required.assistant_instruction`
  (and a small `returned_sample`) so the LLM asks the user to narrow the
  query instead of dumping or stalling. `isError: false`.

---

## [1.5.0] - 2026-07-12

### Added

- Session & identity tools: **`qobrix_sign_in`**, **`qobrix_sign_out`**, **`qobrix_whoami`**
  (64 tools total). Mode C sign-in reuses the existing `/connect` elicitation /
  Markdown link path; sign-out fully revokes via AS `/disconnect` (deletes the
  minted Qobrix API key + AS vault) with a direct Qobrix `DELETE /profile/api-key`
  fallback, then clears the local session vault; whoami returns
  `GET /api/v2/session/` (user + capabilities + portals) with a
  `GET /users/{apiUser}` fallback.

### Changed

- Mode C non-elicitation fallback now returns a Markdown
  **`[Sign In to Qobrix](connectUrl)`** link and instructs the LLM to present it
  verbatim (unique / single-use — never reuse an earlier link).

### Fixed

- **`qobrix_whoami`** no longer routes profile probes through `fetchUpstream`
  (which clears the Mode C vault on 401/403). Uses a non-destructive
  `tryGetPath` so a JWT-only `GET /session/` 401 cannot log the user out.
- **`revokeSession`** snapshots vault credentials before token refresh so a
  failed refresh cannot skip the Qobrix API-key DELETE fallback.
- **`qobrix_sign_in`** "already connected" message prefers `api_user` over the
  raw SHA-256 OAuth subject.
---

## [1.4.2] - 2026-07-12

### Fixed

- When bound to loopback, `QOBRIX_MCP_ALLOWED_HOSTS` now always includes
  `127.0.0.1` / `localhost` / `::1` so local agents (e.g. ragchat →
  `http://127.0.0.1:3502/mcp`) are not rejected with `403 Invalid Host` when the
  env list only names the public reverse-proxy hostname.

### Docs

- Refreshed [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) and README: **61** tools
  (incl. Audit), **217** tests, Mode C reverse-proxy lockdown, Host allowlist,
  cookie Path, and `trust proxy` guidance.

---

## [1.4.1] - 2026-07-12

### Fixed

- Mode C connect cookie `Path` now follows `QOBRIX_MCP_PUBLIC_URL` pathname so
  reverse-proxy `ProxyPassReverseCookiePath` rewrites (e.g. `/` → `/eldes`) cannot
  steal the OAuth state cookie on path-mounted deployments.
- Set Express `trust proxy` when serving behind Apache/Cloudflare so
  `express-rate-limit` accepts `X-Forwarded-For`.

### Docs

- Added [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) covering Modes A → B → C.

---

## [1.4.0] - 2026-07-12

### Mode C self-service OAuth (standards-verified third-party auth)

Mode C no longer requires the northbound MCP client to carry a bearer token.
The MCP is its own OAuth client + session holder against SharpSir’s **Enterprise
OAuth** solution (`qobrix-crm-mcp-oauth`).

When a tool needs auth:

1. **Elicitation-capable clients** receive `URLElicitationRequiredError` (`-32042`)
   with a `/connect` URL (SEP-1036 / MCP 2025-11-25).
2. **Other clients** (ragchat / LangChain) receive plain tool-result text with the
   same URL — the LLM relays it; no host code changes.
3. User opens **`/connect`** (RS-hosted anti-phishing indirection + signed cookie)
   → Enterprise OAuth login → **`/oauth/callback`** → encrypted session vault.
4. Retry runs authenticated. Qobrix `401`/`403` clears the vault and re-prompts.

### Added

- `src/oauth-client.ts` — DCR, PKCE, `/connect` state, token exchange, introspection,
  AES-256-GCM session vault, refresh.
- `GET /connect` and `GET /oauth/callback` HTTP routes.
- `AuthRequiredError` + client-aware `errorResult()` (elicitation vs text fallback).
- `src/request-context.ts` — ALS for `McpServer` (capability detection + completion notify).
- Env: `QOBRIX_MCP_PUBLIC_URL`, `QOBRIX_MCP_STATE_SECRET`, `QOBRIX_MCP_DATA_DIR`.

### Changed

- Mode C drops `requireBearerAuth` / PRM on `/mcp` (client→server auth optional;
  network trust is the boundary — bind loopback).
- Mode description and docs reframed around self-service third-party authorization.

### Security

- Single shared session vault (document + warn on non-loopback bind).
- Connect state is single-use with ~10 min TTL; cookie↔state binding on callback.
- Exact-match `redirect_uri` enforced by the paired AS.

---

## [1.3.0] - 2026-07-12

### Agent-agnostic auth — Streamable HTTP + Modes A / B / C

Version 1.3.0 turns `qobrix-crm-mcp` into a **platform-agnostic MCP server**.
Modes A and B ship in this open-source package. **Mode C** adds per-user OAuth
and requires SharpSir’s separate **Enterprise OAuth** Authorization Server
(login + 2FA + consent, per-user API-key minting, encrypted vault,
audience-bound tokens) — a commercial SSO product delivered **upon request**,
not a public download of this repo.

| Mode | In this package | Role |
|------|-----------------|------|
| **A / B** | Yes | Shared env key, or per-request headers for trusted hosts |
| **C** | Needs companion AS | Per-agent identity via SharpSir’s Enterprise OAuth / SSO |

Contact: [sharpsir.group](https://sharpsir.group) · [dev@sharpsir.group](mailto:dev@sharpsir.group)

### Value proposition

**Modes A/B for shared or trusted-caller credentials; Mode C when every agent
must authenticate as themselves.** Brokerages can put Claude, Cursor, or an
internal agent host in front of live Qobrix data today (Mode A/B). When they
need per-user permissions, audit trails, and self-serve login — not a shared
service account — they deploy Mode C with SharpSir’s Enterprise OAuth product.
No third-party Authorization Servers; Mode C pairs exclusively with that AS.

Why this is a durable differentiator:

- **Open MCP + optional Enterprise SSO.** Clone and run Modes A/B in Cursor /
  Claude under Apache 2.0; pair Mode C with the Enterprise OAuth product when
  multi-user identity matters.
- **Agent-agnostic by design.** Register the remote `/mcp` URL; with Enterprise
  OAuth paired, the client discovers the AS (RFC 9728), completes DCR + PKCE,
  and opens the login page. No custom broker per host.
- **Back-compatible.** Mode A (stdio + env) is unchanged — existing setups keep
  working. Modes B and C are opt-in via env.

### Use cases / user stories

- **Brokerage IT — per-agent CRM access.** *"As IT, I want each sales agent’s MCP
  client to use their own Qobrix identity, so permissions and audit trails stay
  correct."* → Mode C + Enterprise OAuth (upon request).
- **Platform team — trusted internal host.** *"As a PeerPane / ragchat operator, I
  already have the user’s Qobrix key and want to pass it per request."* → Mode B
  (`X-Api-User` / `X-Api-Key` headers) over localhost HTTP.
- **Individual power user — local Cursor.** *"As a broker, I just want Cursor to
  talk to my CRM with one shared key."* → Mode A (default stdio + env), unchanged.

### Added

- **Streamable HTTP transport** (`QOBRIX_MCP_TRANSPORT=http`) via
  `StreamableHTTPServerTransport` on Express — keeps stdio as the default.
- **Three auth modes:**
  - **A** — stdio + shared `QOBRIX_API_*` from process env (default, free).
  - **B** — HTTP + per-request `X-Api-User` / `X-Api-Key` (trusted callers, free).
  - **C** — HTTP + OAuth 2.1 Resource Server for SharpSir’s **Enterprise OAuth
    solution** only (RFC 9728 PRM, bearer validation, introspection).
- **Request-scoped credentials** via `AsyncLocalStorage` (`auth-context.ts`).
- **`QobrixClient.fromEnv()` / `fromContext()`** with a credential-fingerprinted
  LRU so Modes B/C never share cached rows across users.
- **Mode C Resource Server helpers** (`oauth-rs.ts`): exclusive issuer check,
  audience validation, introspection → ALS credentials.
- **OAuth modes smoke test** (`test:oauth-modes`) — Mode B reject/accept +
  Mode C metadata → DCR → 401 → audience-bound introspect.
- **Node 18/20-compatible `.env` preloader** for the test suite (drops the
  Node 20-only `--env-file` dependency).

### Changed

- Modes B/C **fail closed**: no silent fallback to a shared env service account
  when the request auth scope is empty.
- HTTP handler only forwards a JSON-RPC body on `POST` — fixes SSE `GET` /
  session `DELETE` handling (Express’s empty `{}` body no longer corrupts the stream).
- Version bump to **1.3.0**; automated tests now **216**.

### Security

- Exclusive pairing: Mode C rejects any token `iss` other than the Enterprise
  OAuth issuer delivered with the bundle.
- Audience (RFC 8707) bound to the canonical `QOBRIX_MCP_RESOURCE_URL`.
- Credential-scoped cache keys prevent cross-tenant cache leaks.
- Rate limiting on the HTTP transport; warning when Mode A is bound to a
  non-loopback host.

### Notes

- Mode A remains the documented default for local Cursor / Claude Desktop.
- Mode C requires the **Enterprise OAuth solution**, delivered upon request —
  not a public package. Contact SharpSir Group to upgrade.
- No migration for existing Mode A installs.

---

## [1.2.0] - 2026-07-10

### Relevance search on every searchable resource + 2-way matching via search

Version 1.2.0 extends the F1-optimized `search` + `boost[]` + `limit` + `max_scan`
engine from properties/projects to **all** dedicated search tools: contacts, agents,
opportunities, viewings, tasks, offers, and contracts. That also unlocks
**bidirectional lead ↔ listing matching** without a bespoke match tool — including
**project → lead** ranking that the native Qobrix `opportunities/by-property`
endpoint cannot do.

### Value proposition

**AI Search turns your Qobrix CRM into a revenue engine, not a filing cabinet.**
Every agent now matches buyers to inventory in the language they actually think in —
*"downsizing retiree, sea view, step-free access, cash buyer under €400k"* — and gets
a ranked shortlist with a transparent reason for each match. The same engine runs the
match in reverse: point it at a new listing and instantly surface the warmest leads in
the pipeline. No SQL, no saved-filter maintenance, no "let me get back to you."

Why this is a durable differentiator:

- **Speed to first match.** Plain-language demand → ranked listings in one call,
  inside Cursor / Claude / any MCP client — not a 20-minute manual filter session.
- **Nothing slips through.** `max_scan` widens the candidate pool so the perfect-but-
  slightly-off-filter listing still surfaces; `_relevance` + `_matched` explain *why*.
- **Every asset is bidirectional.** New listing → hot leads. New lead → best listings.
  Same engine, same day, zero extra tooling.

### The $$ case for AI Search

Illustrative model for a **20-agent brokerage** (adjust to your desk):

- **Time reclaimed → more selling.** Manual buyer-to-inventory matching and re-checks
  eat roughly **5 hrs/agent/week**. AI Search cuts that by ~**70%** → ~**3.5 hrs/agent/week**
  back to clients. Across 20 agents that's **~3,600 selling hours/year** recovered —
  the equivalent of **~1.7 full-time agents** you don't have to hire.
- **Faster, better matches → higher conversion.** Speed-to-match and "nothing slips
  through" recall lift lead-to-viewing and viewing-to-offer rates. A conservative
  **+1 extra closed deal per agent per year** at a **€6,000 average commission** =
  **+€120,000/year** in new commission on a 20-agent desk.
- **Every stale listing gets a second look.** Reverse matching (new/relisted property →
  ranked warm leads) recycles pipeline that would otherwise go cold, shortening
  **days-on-market** and protecting price.

**Bottom line: a low-to-mid five-figure annual software footprint that plausibly
returns six figures** in recovered agent capacity plus incremental commission — before
counting the brand value of being the AI-native brokerage in your market.

### Use cases / user stories

- **Buyer's agent — demand → supply.** *"As an agent, I paste my buyer's wishlist and
  get a ranked shortlist with match reasons, so I can send curated options in minutes."*
  → `qobrix_search_properties` / `qobrix_search_projects` with `search` (must-haves) +
  `boost[]` (nice-to-haves).
- **Listing agent — supply → demand.** *"As a listing agent, when I win a new mandate I
  want the hottest matching leads instantly."* → `qobrix_search_opportunities` boosted
  on budget/location/type against the new listing's attributes (and `project → lead`
  ranking the native endpoint can't do).
- **Sales manager — pipeline hygiene.** *"As a manager, I want stale opportunities
  re-matched to fresh inventory."* → reverse matching recycles cold leads and cuts
  days-on-market.
- **Ops / back-office — everything is searchable.** Relevance ranking now spans
  contacts, agents, viewings, tasks, offers, and contracts — e.g. *"find the offers and
  contracts most relevant to this deal"* — so the whole CRM is queryable in plain
  language, not just listings.

### Added

- **Relevance ranking on 7 more search tools:**
  `qobrix_search_contacts`, `qobrix_search_agents`, `qobrix_search_opportunities`,
  `qobrix_search_viewings`, `qobrix_search_tasks`, `qobrix_search_offers`,
  `qobrix_search_contracts` — same two-tier recipe as properties/projects.
- **Opportunities & Contacts field cheatsheets** in `qobrix_search_dsl_help`.
- **Lead ↔ listing matching recipes** in server instructions and README
  (demand→supply via property/project search; supply→demand via opportunity boost).
- Unit tests for opportunity/contact-shaped boost scoring.

### Changed

- `relevanceSearch` accepts any Qobrix resource path string (not only properties/projects).
- Search schemas for the 7 resources now include `boost`, `max_scan`, and `fields`
  (where missing) so projection + boost-field union works uniformly.
- DSL help intro documents that the recipe applies to all `qobrix_search_*` tools.

### Notes

- Native match endpoints (`properties/by-lead`, `opportunities/by-property`,
  `opportunities/{id}/properties`) remain available; ranked search complements them.
- No migration: existing `search`-only calls take the fast path.

---

## [1.1.0] - 2026-07-10

### AI-native property search for MCP — the headline feature

Real-estate teams don't search in SQL. They describe what a buyer wants in plain
language: *"a 3-bed villa near the sea in Limassol, budget around half a million,
ideally new build."* Version 1.1.0 makes the Qobrix CRM MCP server turn that
free-language demand into **high-precision, high-recall listing results** — the
kind of AI-driven MLS/property search that is quickly becoming a competitive
differentiator for brokerages, portals, and PropTech products built on
Cursor, Claude, and other Model Context Protocol clients.

### Added

- **Relevance-ranked property & project search (F1-optimized).**
  `qobrix_search_properties` and `qobrix_search_projects` were rebuilt around a
  two-tier design that maximizes the F1 score (precision × recall) of results:
  - **`search`** — hard must-have constraints as a Qobrix DSL filter (server-side
    precision floor).
  - **`boost[]`** — soft, weighted nice-to-haves scored client-side over a wide
    candidate pool (recall + ranking). Each returned row carries a transparent
    **`_relevance`** score and **`_matched`** explanation of which criteria hit.
  - **`limit`** — how many ranked results to return (default 10, max 100).
  - **`max_scan`** — candidate pool size when boosting (default 100, hard cap 500).
    Raise it to reduce the chance of missing a great listing; lower it to keep the
    LLM context lean.
- **`qobrix_search_dsl_help` — an on-demand Search Expression DSL reference.**
  Teaches the LLM the full Qobrix / Symfony Expression Language grammar (operators,
  ranges, `contains`/`starts with`/`ends with`, `DISTANCE_FROM`, `IN_POLYGON`,
  `TRANSLATED`, `MIN`/`MAX`, date helpers like `DAYS_AGO(n)`, and association paths).
  Pass `resource: "Properties"` or `"Projects"` to append a field cheatsheet plus
  live, cached schema field names — so generated queries are correct on the first try.
- **New `src/relevance.ts` and `src/search-dsl.ts` modules**, with a pure,
  unit-tested `mergeBoostFields()` helper.
- **17 new relevance unit tests** and **3 new search-cache regression tests**
  (boost scoring, ranking order, `fields[]` + `boost` correctness, DSL help text,
  and cache-key stability) — all runnable offline with no live API.

### Changed

- **Search caching verified end-to-end.** Every relevance candidate page flows
  through the existing single chokepoint (`QobrixClient.request()` →
  read-through cache), so search — including each `max_scan` page — is fully
  response-cached. Boost scoring is post-fetch and does not affect the cache key,
  so re-ranking with different `boost[]` reuses the same cached candidate pages.
  Refresh after CRM edits with
  `qobrix_cache_clear({ prefix: "v1:request:properties" })`.
- **Richer LLM guidance.** The shared `SEARCH_DESCRIPTION`, both search tool
  descriptions, and the server `instructions` now document the two-tier
  `search` + `boost` recipe and the `limit` / `max_scan` overload-vs-missing
  trade-off, and point to `qobrix_search_dsl_help`.
- **README** updated with the full operator/function table, the relevance-search
  recipe, and a worked example.

### Fixed

- **`fields[]` + `boost` no longer breaks ranking.** When a caller restricted the
  response projection, boost clauses previously scored against absent fields and
  ranking silently degraded. Boost fields (plus `id`) are now always unioned into
  the fetched projection.
- Ranked-mode pagination no longer advertises a misleading `has_next_page`
  (widen the pool with `max_scan`, not `page`).

### Notes

- **100% read-only.** Every MCP tool is a `GET`; the response cache cannot corrupt
  CRM state. No Qobrix schema or credential changes are required to adopt 1.1.0.
- **No migration needed.** Existing `search`-only calls keep working (they take the
  fast path); add `boost[]` when you want relevance ranking.

---

## [1.0.0] - 2026-05

### Added

- Initial public release of the **read-only Qobrix CRM MCP server** for Cursor,
  Claude Desktop, and other Model Context Protocol clients.
- CRM entity tools (properties, projects, contacts, agents, opportunities/leads,
  viewings, tasks, media, offers, contracts, calls, meetings, email messages).
- Schema discovery (`qobrix_get_schema`, `qobrix_get_field_options`).
- Analytics (`qobrix_count`, `qobrix_top_values`, `qobrix_top_records`,
  `qobrix_aggregate`), the `qobrix_deals` shortcut, reporting tools
  (`qobrix_timeseries`, `qobrix_funnel`, `qobrix_rep_scorecard`,
  `qobrix_stale_leads`, `qobrix_win_loss`, `qobrix_days_on_market`),
  and `qobrix_cohort`.
- Optional **Redis-backed response caching** with in-memory LRU, single-flight
  coalescing, and cache controls (`qobrix_cache_stats`, `qobrix_cache_clear`).
- RESO Data Dictionary 2.0 aligned workflows and output-size capping.

[1.2.0]: https://github.com/sharpsir-group/qobrix-crm-mcp/releases/tag/v1.2.0
[1.1.0]: https://github.com/sharpsir-group/qobrix-crm-mcp/releases/tag/v1.1.0
[1.0.0]: https://github.com/sharpsir-group/qobrix-crm-mcp/releases/tag/v1.0.0
