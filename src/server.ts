import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools/index.js";

const require = createRequire(import.meta.url);
const PACKAGE_VERSION = (require("../package.json") as { version: string }).version;

export const SERVER_INSTRUCTIONS = `
Qobrix CRM MCP Server — read-only access to a real-estate CRM aligned with RESO DD 2.0 canonical processes.

## Canonical RE Workflows (RESO-aligned)

This CRM supports six core real-estate business processes. Use the tool recipes below to serve each workflow.

### 1. Listing Lifecycle (RESO Property.StandardStatus)
A property listing moves through: Incomplete → Active → Pending → Closed/Withdrawn.
Qobrix status mapping: "available" = Active, "reserved" = Pending/Under Contract, "sold" = Closed, "withdrawn" = Withdrawn/Canceled.
- **Check listing inventory**: qobrix_search_properties with status == "available" and sale_rent == "for_sale"
- **Drill into a listing**: qobrix_get_property with include=['PropertyTypes','Agents','PropertyViewings']
- **Listing media check**: qobrix_list_media with related_model='Properties' and related_id=<uuid>
- **Map view**: qobrix_get_property_coordinates with optional search filter
- **Track price changes**: qobrix_list_properties sorted by -modified with status == "available"
- **Sold-inventory view**: qobrix_search_properties with status == "sold" (post-close inventory state; for the *deal records* use qobrix_deals)

### 2. Lead-Contact Lifecycle (RESO Contacts.ContactType funnel)
A person flows: Lead → Prospect → Ready to Buy → Buyer (or Seller/Tenant/Other).
Qobrix maps this as Opportunities with status: "new" = Lead/MQL, "open" = SQL/Active, "won" = Closed Won, "closed_lost" = Lost.
- **Lead pipeline overview**: qobrix_search_opportunities by status to count funnel stages
- **Qualify a lead**: qobrix_get_opportunity with include=['ContactNameContacts'] to see who they are
- **Lead source analysis**: qobrix_list_opportunities with fields=['source','source_description','enquiry_type']
- **Contact ownership**: qobrix_get_contact with include=['AssignedToUsers'] (maps to RESO OwnerMember)
- **Find a contact's leads**: qobrix_search_opportunities with contact_name == '<contact-uuid>'
- **Find a contact's tasks**: qobrix_search_tasks with contact == '<contact-uuid>'

### 3. Sales Pipeline (8-stage buyer journey)
Qualification → Demand Research → Solution/Viewing → Decision Making → Deal Signing → Payment → Closed Won/Lost.
- **Buyer-property matching**: for free-language demand use **qobrix_search_properties** with hard search + soft boost[] (see Search below). Also qobrix_get_leads_by_property (who wants this property?) or qobrix_get_lead_properties (what does this lead want?)
- **Viewing stage**: qobrix_list_viewings or qobrix_get_property with include=['PropertyViewings']
- **Offer stage**: qobrix_list_offers with include=['OpportunityOpportunities','PropertyProperties']
- **Contract/signing stage**: qobrix_list_contracts with include=['Contacts','PropertyIdProperties','PaymentInstallments']
- **Pipeline tasks**: qobrix_list_tasks with include=['TaskStatus','AssignedToUsers','ContactContacts']

### 4. Showing/Viewing Lifecycle (RESO ShowingRequest → Appointment → Showing)
In Qobrix, PropertyViewings track scheduled visits. Meetings can wrap viewings.
- **List viewings**: qobrix_list_viewings with include=['PropertyViewingViewing']
- **Property's viewings**: qobrix_get_property with include=['PropertyViewings']
- **Meetings with viewings**: qobrix_list_meetings with include=['ViewingPropertyViewings','ContactContacts']
- The first showing/meeting is the trigger that moves a lead from follow-up (nurturing) to active sales.

### 5. Transaction/Offer Lifecycle (RESO TransactionManagement)
Offer → Contract → Payment → Close. The chain: Offer links Opportunity + Property; Contract formalizes the deal.
- **Offer chain**: qobrix_list_offers with include=['OpportunityOpportunities','PropertyProperties']
- **Contract details**: qobrix_get_contract with include=['Contacts','PropertyIdProperties','PaymentInstallments','ContractParties']
- **Deals (sales, rentals, listings, pipeline)**: prefer **qobrix_deals** — covers every "deal" question in one call. Deals live in the **Contracts** table. The default "closed deal" = contract_type == "cos" AND contract_status == "agreed", but rentals (tenancy_agreement), listing agreements, and under-contract reservations (contract_status == "reserved") are also deals. qobrix_deals accepts kind ("sale"|"rental"|"listing"|"any_revenue"|"any"), explicit contract_types[]/contract_statuses[], date_field + year/from/to/since_days, min_price/max_price, assigned_to/commission_to/commission_to_2/agent, and a raw search escape hatch. Property.status "sold" is the post-close inventory state, *not* the deal record — never use it as a substitute for the Contracts query.
- **Top-N by amount on contracts/opportunities**: prefer server-side sort='-final_selling_price_amount' on list/search when a single page is enough. For full-dataset top-N (or nullable fields like opportunities.budget where server sort can return no rows), use **qobrix_top_records**.
- **Sums / averages / leaderboards**: use **qobrix_aggregate** (e.g. op="sum" field="final_selling_price_amount" group_by="commission_to_2" for an agent leaderboard by 2026 volume).

### 6. Activity Tracking / Follow-up
Zero tolerance on missed follow-ups. Daily cadence for active deals. Track all touchpoints.
- **Call history**: qobrix_list_calls with include=['ContactContacts','AssignedToUsers']
- **Meeting history**: qobrix_list_meetings with include=['ContactContacts','AssignedToUsers']
- **Email trail**: qobrix_list_email_messages with include=['ContactContacts','Properties']
- **Overdue tasks**: qobrix_search_tasks with due_date <= NOW and status == "pending"
- **My open tasks**: qobrix_search_tasks with assigned_to == CURRENT_USER and status != "completed"

## Data Model (entities and how they relate)
- **Properties** — real-estate listings. FK: agent→Agents, seller→Contacts, project→Projects, salesperson→Users. Status: available/reserved/sold/withdrawn.
- **Contacts** — people/companies (buyers, sellers, tenants). RESO ContactType: Lead/Prospect/Buyer/Seller/Other.
- **Opportunities** — leads/enquiries. FK: contact_name→Contacts, agent→Agents. Status: new/open/won/closed_lost. This IS the lead pipeline.
- **Agents** — brokers managing properties and leads. Referenced by property.agent. RESO Member equivalent.
- **Projects** — property developments grouping units. Referenced by property.project.
- **Offers** — purchase offers linking Opportunity + Property. RESO TransactionManagement equivalent.
- **Contracts** — sale/rental agreements linking Contacts + Properties + Opportunities.
- **Tasks** — CRM tasks tied to any entity. Used for follow-up scheduling and pipeline management.
- **Property Viewings** — scheduled showings. RESO Showing/ShowingAppointment equivalent.
- **Calls, Meetings, Email Messages** — activity history for engagement tracking.
- **Media** — photos, documents, floor plans attached to any entity. RESO Media equivalent.

## Fetching related data
Three strategies to resolve foreign keys:
1. **include[] parameter** — expand associations inline in one call (e.g. include=['Agents','PropertyViewings']).
2. **Separate get call** — take the UUID from an FK field and call the appropriate get tool.
3. **Search by FK** — find related records via search (e.g. search properties with agent == '<uuid>').
Prefer include[] when available. Use search-by-FK when include[] is unavailable. Only include values marked "Verified" in tool descriptions are guaranteed to work.

## Search expression syntax
Operators: ==, !=, <>, <, >, <=, >=, in, not in, contains, starts with, ends with.
Combine with: and, or, not. Ranges: field in 200000..800000. Lists: field in ["a","b"].
Functions: DISTANCE_FROM, IN_POLYGON, TRANSLATED, MIN/MAX, DAYS_AGO(n), MONTHS_AGO(n), DAYS_FROM_NOW(n).
Shortcuts: NOW, TODAY, THIS_WEEK, LAST_MONTH, THIS_YEAR, CURRENT_USER.
String values must be double-quoted. Boolean fields use true/false without quotes.
Association paths: SalespersonUsers.Contacts.country == "CY".
Example: status == "available" and sale_rent == "for_sale" and list_selling_price_amount <= 500000
**Full grammar + field cheatsheets**: call **qobrix_search_dsl_help** (optional resource='Properties'|'Projects').

## Relevant search on ALL qobrix_search_* tools (F1)
Every search tool supports the two-tier recipe (properties, projects, contacts, agents, opportunities, viewings, tasks, offers, contracts):
1. search = hard must-haves (server DSL filter → precision).
2. boost[] = soft weighted nice-to-haves scored over up to max_scan candidates (recall + ranking). Each row gets _relevance and _matched.
3. limit = how many ranked results to return (default 10, max 100).
4. max_scan = candidate pool when boosting (default 100, hard cap 500; auto-capped at 100 when expand or media is true — see pagination.scan_capped_reason). Higher = better recall, more cached API pages.
Without boost → fast path (single cached list page). All list/search pages share QOBRIX_CACHE_TTL (default 300s); refresh with qobrix_cache_clear({prefix:'v1:request:properties'}).

## Lead <-> listing matching via search (2-way)
- Demand→supply: read a lead's criteria (bedrooms_from/to, price ranges, area_of_interest, buy_rent, …) then qobrix_search_properties / qobrix_search_projects with search+boost. Also native: qobrix_get_properties_by_lead / qobrix_get_lead_properties.
- Supply→demand: qobrix_search_opportunities with search='status in ["new","open"]' and boost against the listing's city/bedrooms/price (works for projects too). Also native for properties only: qobrix_get_leads_by_property.

## Pagination
All list endpoints return { data: [...], pagination: { count, current_page, has_next_page, has_prev_page, page_count, limit } }.
Default limit=10, max 100. Exception: Media list returns { data: [...] } without pagination.

## Payload defaults (important for big resources like Properties)
List / search / get tools default to compact payloads:
- **expand=false** — foreign keys come back as UUID strings, not nested objects. To resolve a UUID into a name, either call the corresponding get tool, use the include[] whitelist for the specific association you need, or rely on the high-level tools which auto-resolve common FKs.
- **media=false** — inline media (photos, floor plans, thumbnails) is *not* attached to list rows. For media use qobrix_list_media(related_model='<Resource>', related_id=<uuid>).
Override per call only when you actually need the heavier payload: pass expand=true and/or media=true. Prefer include[] for surgical expansion of specific associations.

## Output cap
Every tool result is capped at QOBRIX_MCP_MAX_RESULT_CHARS chars of rendered JSON (default 30,000 ≈ ~7.5 K tokens). When a paginated payload exceeds the cap it is truncated to the largest prefix of data[] that fits (rows may be compacted to scalars if nested expand/media objects alone blow the cap) and a "_truncated" block is attached. When the payload is grossly oversized (default: >8× the cap, override QOBRIX_MCP_REFINE_MULTIPLIER) or compaction still cannot fit a usable page, the tool returns status="result_too_large" with _refine_required — tell the user to narrow the query (filters, fields[], smaller limit, drop expand/media) and retry. Do not dump or invent rows.

## Discovering field names
Call qobrix_search_dsl_help for search grammar, or qobrix_get_schema with the resource name (e.g. 'Properties', 'Contacts', 'Opportunities') to discover all fields, types, and validation rules. Use qobrix_get_field_options for enum values.

## Reporting cookbook (analyst-grade questions in one call)

When the user asks anything that maps to a recurring sales/management report, prefer one of these high-level tools over composing many primitive calls — they encode canonical business definitions and avoid Qobrix's sort/aggregate quirks:

- **Trend / YoY / monthly volume** → **qobrix_timeseries** (bucket=day|week|month|quarter|year, metric=count|sum|avg|min|max, optional compare_to_prior=true for prior-window YoY %). Default date_field per resource (contracts→date_of_contract, everything else→created).
- **Sales funnel + conversion %** → **qobrix_funnel**. Six canonical stages: leads → qualified → viewing → offer → reserved → closed. Scope with year/from/to/since_days, optional assigned_to (UUID or "CURRENT_USER") and agent. Use stage_overrides for tenant-specific stage definitions.
- **Rep productivity / agent leaderboard / "my scorecard"** → **qobrix_rep_scorecard**. Omit the 'user' arg for a top-N leaderboard sorted by volume/commission/deals_closed/activities/viewings. Pass user="CURRENT_USER" for a single-rep wide row.
- **Silent / stale leads** → **qobrix_stale_leads** (default since_days=30, statuses=["new","open"]). Builds a recent-activity set from calls/meetings/email-messages/tasks and returns open opportunities not in it whose opportunity row itself wasn't modified within the window.
- **Repeat customers / cohort** → **qobrix_cohort**. Modes: 'buyers' (default, walks closed contracts → opportunity_id → opportunity.contact_name), 'sellers' (walks contracts → property_id → property.seller), 'leads' (groups opportunities by contact_name). Each repeat contact comes back with deal_count, total_volume, total_commission, first_deal, last_deal, and a deals[] breakdown.
- **Win / loss analytics** → **qobrix_win_loss**. Returns global counts (new / open / won / closed_lost) and win_rate_pct. Optional group_by 'source' / 'enquiry_type' / 'owner' / 'agent' / 'closed_lost_reason_id' (or arrays for multi-dim). Window applied to last_status_change (fallback modified). Set include_top_losses=true for recent closed_lost details + resolved reason labels.
- **Days on market** → **qobrix_days_on_market**. Joins Contracts → Properties on property_id, computes days = close_date − listing_date. Returns mean / median / p75 / p90 / min / max. kind defaults to 'sold' (cos + agreed). group_by 'property_type', 'city', 'agent', etc. Set include_outliers=true for top-5 longest and shortest deals.
- **Multi-dimensional pivot (e.g. city × property_type)** → **qobrix_aggregate** with group_by as an array of 2-3 fields.

Implementation note for stale leads: activity rows expose the linked opportunity under one of related_opportunity / related_opportunity_id / opportunity_id / opportunity (varies by tenant). The tool reads all of them defensively.

Implementation note for win_loss / closed_lost_reason_id: the reason FK points at the lead-lost-reasons resource (label field is description). resolveId() now handles this automatically — agents can pass the raw UUID and the tool will emit the human-readable reason.

## Known quirks
- Opportunities: avoid include=['Locations'] in list calls unless you also select the location FK in fields[].
- Media endpoint does not support search expressions or pagination metadata.
- Sort: prefix with - for descending (e.g. sort='-created', sort='-list_selling_price_amount'). Maps to the API sort[] array param.
- **Nullable/computed fields**: most numeric sorts work server-side. A few nullable columns (e.g. opportunities.budget) can return no rows under sort — for those, or for top-N across the whole matching set, use **qobrix_top_records** (fetches + sorts in-process). For totals, use **qobrix_aggregate**.
- **Closed deals are *not* properties with status="sold"**: that flag tracks the listing's post-close inventory state. The deal record lives in **Contracts**. Use **qobrix_deals** for any "closed deals / top sales / rentals / pipeline" question.
`.trim();

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "qobrix-crm-mcp",
      version: PACKAGE_VERSION,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  const register = server.registerTool.bind(server);
  server.tool = ((name: string, ...rest: unknown[]) => {
    let description: string | undefined;
    const args = [...rest];
    if (typeof args[0] === "string") description = args.shift() as string;
    let inputSchema: unknown;
    if (args.length > 1 && args[0] && typeof args[0] === "object") inputSchema = args.shift();
    const cb = args[args.length - 1];
    return register(name, {
      title: name.replace(/^qobrix_/, "").replaceAll("_", " "),
      description,
      inputSchema: inputSchema as never,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    }, cb as never);
  }) as typeof server.tool;

  registerTools(server);
  return server;
}
