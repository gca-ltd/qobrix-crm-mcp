import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../client.js";
import { relevanceSearch } from "../relevance.js";
import {
  ListOpportunitiesSchema,
  GetOpportunitySchema,
  SearchOpportunitiesSchema,
  GetLeadsByPropertySchema,
  GetLeadPropertiesSchema,
} from "../schemas.js";
import { formatResult, errorResult } from "./index.js";

export function registerOpportunityTools(server: McpServer): void {
  server.tool(
    "qobrix_list_opportunities",
    "List opportunities/leads from Qobrix CRM — the central entity of the Sales Pipeline and Lead-Contact Lifecycle. " +
    "In Qobrix, leads ARE opportunities. Each represents a buyer/renter/investor enquiry. " +
    "RESO funnel mapping: 'new' = MQL/Lead, 'open' = SQL/Active, 'won' = Closed Won, 'closed_lost' = Lost. " +
    "Returns { data: [...], pagination: { count, current_page, has_next_page, ... } }. " +
    "IMPORTANT: Avoid include=['Locations']. Safe verified includes: ContactNameContacts, Properties, " +
    "AgentAgents, PropertyTypes, ClosedLostReason, User, OwnerUsers. " +
    "Key fields (77 total): status, enquiry_type (buy/rent/invest), buy_rent, " +
    "contact_name (UUID → Contact), agent (UUID → Agent), owner (UUID → user), " +
    "source, area_of_interest, bedrooms_from/to, price ranges, next_follow_up_date, enquiry_date. " +
    "Workflow patterns: " +
    "Pipeline overview: group by status to see funnel distribution. " +
    "Overdue follow-ups: status == \"open\" and next_follow_up_date <= NOW. " +
    "New leads this week: created >= THIS_WEEK and status == \"new\". " +
    "Two-way matching: demand→supply via qobrix_search_properties with lead criteria; " +
    "supply→demand via this tool with boost against a listing (or native qobrix_get_leads_by_property).",
    ListOpportunitiesSchema.shape,
    async ({ limit, page, sort, fields, include, search }) => {
      try {
        const result = await getClient().list("opportunities", {
          limit, page, sort, fields, include, search,
        });
        return formatResult(result);
      } catch (error) {
        return errorResult(error, "qobrix_list_opportunities");
      }
    }
  );

  server.tool(
    "qobrix_get_opportunity",
    "Get a single lead/opportunity by UUID — drill into a pipeline deal in the Sales Pipeline workflow. " +
    "Returns { data: { id, ref, status, enquiry_type, contact_name, agent, ... } }. " +
    "RESO mapping: status 'new' = Lead, 'open' = Active/SQL, 'won' = Closed Won, 'closed_lost' = Lost. " +
    "Verified include: ContactNameContacts (the person), Properties (linked listings), " +
    "AgentAgents (assigned broker, RESO ListAgent), PropertyTypes, ClosedLostReason, User, OwnerUsers. " +
    "Canonical deal drill-down pattern: " +
    "1. Get the lead with include=['ContactNameContacts','Properties','AgentAgents'] " +
    "2. Check showing history: qobrix_list_viewings (search by related property) " +
    "3. Check offers: qobrix_search_offers for this lead " +
    "4. Check activity: search Tasks, Calls, Meetings linked to this opportunity " +
    "FK: contact_name → Contacts, agent → Agents, owner → Users.",
    GetOpportunitySchema.shape,
    async ({ id, include }) => {
      try {
        const result = await getClient().get("opportunities", id, { include });
        return formatResult(result);
      } catch (error) {
        return errorResult(error, "qobrix_get_opportunity");
      }
    }
  );

  server.tool(
    "qobrix_search_opportunities",
    "Relevance-ranked lead/opportunity search (F1-optimized) — primary pipeline filter AND supply→demand matching. " +
    "TWO-TIER: `search` = hard must-haves; `boost[]` = soft weighted preferences scored over `max_scan` candidates; " +
    "`limit` = top-N. With boost: `_relevance` + `_matched`; pagination.mode='ranked'. " +
    "Call qobrix_search_dsl_help({resource:'Opportunities'}) for DSL + buyer-criteria fields. " +
    "Pipeline recipes: status == \"open\"; created >= THIS_WEEK and status == \"new\"; " +
    "next_follow_up_date <= NOW and status == \"open\". " +
    "Supply→demand (who wants this listing?): search='status in [\"new\",\"open\"] and buy_rent == \"buy\"', " +
    "boost=[{field:'area_of_interest',op:'contains',value:'Limassol',weight:3}," +
    "{field:'bedrooms_from',op:'<=',value:3,weight:2},{field:'list_selling_price_to',op:'>=',value:400000,weight:2}], " +
    "limit=15, max_scan=200. Works for projects too (native by-property does not).",
    SearchOpportunitiesSchema.shape,
    async ({ search, boost, max_scan, limit, page, sort, fields }) => {
      try {
        const result = await relevanceSearch({
          resource: "opportunities",
          search, boost, max_scan, limit, page, sort, fields,
        });
        return formatResult(result);
      } catch (error) {
        return errorResult(error, "qobrix_search_opportunities");
      }
    }
  );

  server.tool(
    "qobrix_get_leads_by_property",
    "Get matching leads for a property — the 'supply-side matching' tool in the Sales Pipeline. " +
    "Answers: 'Who is interested in this listing?' by returning leads whose criteria match the property. " +
    "This is the canonical buyer-property matching pattern (RESO Prospecting). " +
    "Use after listing a new property to find potential buyers in the existing lead database. " +
    "Complement with qobrix_get_lead_properties for the reverse (demand-side) match, " +
    "or qobrix_search_opportunities with boost for ranked matching (incl. projects). " +
    "The propertyId is the Property UUID. Returns paginated results.",
    GetLeadsByPropertySchema.shape,
    async ({ propertyId, limit, page }) => {
      try {
        const params: Record<string, string | number | undefined> = { limit, page };
        const result = await getClient().getPath(
          `opportunities/by-property/${propertyId}`, params
        );
        return formatResult(result);
      } catch (error) {
        return errorResult(error, "qobrix_get_leads_by_property");
      }
    }
  );

  server.tool(
    "qobrix_get_lead_properties",
    "Get properties linked to a lead — the 'demand-side matching' tool in the Sales Pipeline. " +
    "Answers: 'What properties does this buyer want?' by returning properties attached to an opportunity. " +
    "This is the canonical property suggestion pattern (RESO Demand/Solution matching). " +
    "Reverse of qobrix_get_leads_by_property (which finds leads for a property). " +
    "For free-language / ranked demand→supply (incl. projects), use qobrix_search_properties / " +
    "qobrix_search_projects with search+boost derived from the lead's criteria. " +
    "In the 8-stage buyer journey, use at the Solution/Viewing stage to prepare showing candidates. " +
    "The id is the Opportunity UUID.",
    GetLeadPropertiesSchema.shape,
    async ({ id }) => {
      try {
        const result = await getClient().getSubresource("opportunities", id, "properties");
        return formatResult(result);
      } catch (error) {
        return errorResult(error, "qobrix_get_lead_properties");
      }
    }
  );
}
