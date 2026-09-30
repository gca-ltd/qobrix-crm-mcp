import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../client.js";
import { relevanceSearch } from "../relevance.js";
import {
  ListProjectsSchema,
  GetProjectSchema,
  SearchProjectsSchema,
  GetProjectCoordinatesSchema,
} from "../schemas.js";
import { formatResult, errorResult } from "./index.js";

export function registerProjectTools(server: McpServer): void {
  server.tool(
    "qobrix_list_projects",
    "List projects (property developments/complexes) — RESO Project equivalent for off-plan and new-build listings. " +
    "Projects group multiple property units under one development, relevant in the Listing Lifecycle for new-builds. " +
    "Returns { data: [...], pagination: { count, current_page, has_next_page, ... } }. " +
    "Properties reference their project via the 'project' FK. " +
    "Verified include: Agents, Developer, Translations, LocationLocations, Assignee, Recommended, Favorites. " +
    "Workflow: to see units in a project, qobrix_search_properties with project == '<uuid>'.",
    ListProjectsSchema.shape,
    async ({ limit, page, sort, fields, include, search }) => {
      try {
        const result = await getClient().list("projects", {
          limit, page, sort, fields, include, search,
        });
        return formatResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "qobrix_get_project",
    "Get a single project by UUID — development detail view for off-plan/new-build listings. " +
    "Returns { data: { id, ... } }. " +
    "Verified include: Agents, Developer, Translations, LocationLocations, Assignee, Recommended, Favorites. " +
    "To see project units: qobrix_search_properties with project == '<uuid>'. " +
    "To see project media: qobrix_list_media with related_model='Projects' and related_id=<uuid>.",
    GetProjectSchema.shape,
    async ({ id, include }) => {
      try {
        const result = await getClient().get("projects", id, { include });
        return formatResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "qobrix_search_projects",
    "Highly relevant project (development) search for free-language demand (F1-optimized). " +
    "TWO-TIER RECIPE: " +
    "(1) `search` = hard DSL must-haves (server filter → precision). " +
    "(2) `boost[]` = soft weighted nice-to-haves scored over up to `max_scan` candidates " +
    "(recall + ranking). " +
    "(3) `limit` = how many ranked rows to return (default 10, max 100). " +
    "With boost: top-N with `_relevance` and `_matched`; pagination.mode='ranked'. " +
    "Without boost: fast path single cached page; pagination.mode='fast'. " +
    "Call qobrix_search_dsl_help({resource:'Projects'}) for DSL + field cheatsheet. " +
    "Example: search='city contains \"Paphos\"', " +
    "boost=[{field:'starting_price_from',op:'<=',value:400000,weight:2}," +
    "{field:'construction_stage',op:'==',value:'under_construction',weight:1}], " +
    "limit=10, max_scan=150. " +
    "When expand=true or media=true, max_scan is auto-capped at 100. " +
    "If status='result_too_large' with _refine_required, ask the user to narrow then retry. " +
    "All upstream pages are response-cached.",
    SearchProjectsSchema.shape,
    async ({ search, boost, max_scan, limit, page, sort, fields, media, expand }) => {
      try {
        const result = await relevanceSearch({
          resource: "projects",
          search,
          boost,
          max_scan,
          limit,
          page,
          sort,
          fields,
          media,
          expand,
        });
        return formatResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "qobrix_get_project_coordinates",
    "Get lat/lng coordinates for projects, for a map. " +
    "Use when the user wants development pins rather than project cards. " +
    "Returns an array of { id, coordinates }. " +
    "Notes: pass search to limit the set. " +
    "Examples: search='city contains \"Limassol\"'. " +
    "Related: qobrix_list_projects, qobrix_search_help.",
    GetProjectCoordinatesSchema.shape,
    async ({ search }) => {
      try {
        const params: Record<string, string | undefined> = { search };
        const result = await getClient().getPath("projects/coordinates", params);
        return formatResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
