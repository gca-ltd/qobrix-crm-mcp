import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../client.js";
import {
  GetSchemaSchema,
  GetFieldOptionsSchema,
  SearchDslHelpSchema,
} from "../schemas.js";
import { buildDslHelpText } from "../search-dsl.js";
import { formatResult, errorResult } from "./index.js";

function schemaFieldNames(schemaPayload: unknown): string[] {
  if (!schemaPayload || typeof schemaPayload !== "object") return [];
  const root = schemaPayload as Record<string, unknown>;
  // Qobrix schema responses vary: { data: { fields: {...} } } or { fields: {...} } or array
  const data = (root.data ?? root) as Record<string, unknown>;
  const fields = data.fields ?? data;
  if (Array.isArray(fields)) {
    return fields
      .map((f) => {
        if (typeof f === "string") return f;
        if (f && typeof f === "object" && "name" in f) {
          return String((f as { name: unknown }).name);
        }
        return "";
      })
      .filter(Boolean)
      .sort();
  }
  if (fields && typeof fields === "object") {
    return Object.keys(fields as Record<string, unknown>).sort();
  }
  return [];
}

export function registerMetaTools(server: McpServer): void {
  server.tool(
    "qobrix_get_schema",
    "Get the full field schema for any CRM resource — the Schema Discovery tool. " +
    "CALL THIS FIRST when unsure about field names for search, fields[], or sort. " +
    "Returns every field with name, type, label, and validation rules (RESO Data Dictionary equivalent). " +
    "Resources (case-sensitive): Properties, Contacts, Opportunities, Agents, Tasks, " +
    "PropertyViewings, Projects, Offers, Contracts, Calls, Meetings, EmailMessages, " +
    "Media, PropertyTypes, PropertySubtypes, PropertyFeatures, Locations. " +
    "Canonical use: before building search expressions for any workflow (Listing, Sales Pipeline, Follow-up), " +
    "call this to discover the correct field names. The schema is the source of truth. " +
    "Pair with qobrix_get_field_options to see allowed enum values for dropdown fields. " +
    "For search grammar, prefer qobrix_search_dsl_help.",
    GetSchemaSchema.shape,
    async ({ resource }) => {
      try {
        const result = await getClient().getPath(`schema/${resource}`);
        return formatResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "qobrix_get_field_options",
    "Get dropdown/enum field options — discover valid values for status fields, types, and categories. " +
    "Essential for building correct search expressions in any workflow. " +
    "Returns { data: [...], pagination: { ... } }. Each item has: id, resource, field, label, value. " +
    "Key examples for canonical workflows: " +
    "Listing statuses: search='resource == \"Properties\" and field == \"status\"' → available/reserved/sold/withdrawn. " +
    "Lead statuses: search='resource == \"Opportunities\" and field == \"status\"' → new/open/won/closed_lost. " +
    "Property types: search='resource == \"Properties\" and field == \"property_type\"'. " +
    "Task types: search='resource == \"Tasks\" and field == \"task_type\"'. " +
    "Pair with qobrix_get_schema for complete field discovery.",
    GetFieldOptionsSchema.shape,
    async ({ limit, page, search }) => {
      try {
        const result = await getClient().list("field-options", {
          limit, page, search,
        });
        return formatResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  for (const toolName of ["qobrix_search_dsl_help", "qobrix_search_help"]) server.tool(
    toolName,
    "Return the full Qobrix Search Expression DSL reference so you can build correct `search` strings " +
    "and `boost[]` clauses for ANY qobrix_search_* tool (properties, projects, contacts, agents, " +
    "opportunities, viewings, tasks, offers, contracts). " +
    "Includes operators, functions, date helpers, association paths, and the two-tier relevance recipe " +
    "(hard `search` filter + soft `boost` ranking + limit/max_scan). " +
    "Optional `resource` (e.g. 'Properties', 'Opportunities', 'Contacts') appends a field cheatsheet " +
    "and live schema field names (schema fetch is response-cached). Call before composing free-language queries.",
    SearchDslHelpSchema.shape,
    async ({ resource }) => {
      try {
        let text = buildDslHelpText(resource);
        if (resource) {
          const lower = resource.trim().toLowerCase();
          const schemaName =
            lower === "properties" || lower === "property"
              ? "Properties"
              : lower === "projects" || lower === "project"
                ? "Projects"
                : lower === "opportunities" || lower === "opportunity" || lower === "leads" || lower === "lead"
                  ? "Opportunities"
                  : lower === "contacts" || lower === "contact"
                    ? "Contacts"
                    : lower === "agents" || lower === "agent"
                      ? "Agents"
                      : lower === "tasks" || lower === "task"
                        ? "Tasks"
                        : lower === "offers" || lower === "offer"
                          ? "Offers"
                          : lower === "contracts" || lower === "contract"
                            ? "Contracts"
                            : lower === "propertyviewings" || lower === "property-viewings" || lower === "viewings"
                              ? "PropertyViewings"
                              : resource.trim().charAt(0).toUpperCase() + resource.trim().slice(1);
          try {
            const schema = await getClient().getPath(`schema/${schemaName}`);
            const names = schemaFieldNames(schema);
            if (names.length > 0) {
              text +=
                `\n# Live schema fields (${schemaName})\n\n` +
                names.map((n) => `- \`${n}\``).join("\n") +
                "\n";
            }
          } catch (schemaErr) {
            const msg =
              schemaErr instanceof Error ? schemaErr.message : String(schemaErr);
            text += `\n# Live schema\nCould not load schema/${schemaName}: ${msg}\n`;
          }
        }
        return formatResult({ dsl_help: text, resource: resource ?? null });
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
