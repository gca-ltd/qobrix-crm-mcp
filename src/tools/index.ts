import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UrlElicitationRequiredError } from "@modelcontextprotocol/sdk/types.js";
import { registerPropertyTools } from "./properties.js";
import { registerContactTools } from "./contacts.js";
import { registerAgentTools } from "./agents.js";
import { registerOpportunityTools } from "./opportunities.js";
import { registerViewingTools } from "./viewings.js";
import { registerTaskTools } from "./tasks.js";
import { registerMediaTools } from "./media.js";
import { registerProjectTools } from "./projects.js";
import { registerOfferTools } from "./offers.js";
import { registerContractTools } from "./contracts.js";
import { registerActivityTools } from "./activities.js";
import { registerMetaTools } from "./meta.js";
import { registerAnalyticsTools } from "./analytics.js";
import { registerDealTools } from "./deals.js";
import { registerReportTools } from "./reports.js";
import { registerPipelineTools } from "./pipeline.js";
import { registerProductivityTools } from "./productivity.js";
import { registerCustomerTools } from "./customers.js";
import { registerCacheTools } from "./cache.js";
import { registerAuditTools } from "./audit.js";
import { registerSessionTools } from "./session.js";
import { AuthRequiredError, registerElicitationNotifier } from "../oauth-client.js";
import {
  clientSupportsUrlElicitation,
  getRequestMcpServer,
} from "../request-context.js";

// Hard cap on tool result size, in characters of the rendered JSON text.
// Default 30 000 chars ≈ 7.5 K tokens, which keeps a multi-tool turn well under
// any modern LLM context window. Override with QOBRIX_MCP_MAX_RESULT_CHARS.
// Set to 0 to disable capping entirely (not recommended in production).
function getMaxResultChars(): number {
  const raw = process.env.QOBRIX_MCP_MAX_RESULT_CHARS;
  if (raw === undefined) return 30_000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 30_000;
  return n;
}

// When original payload is this many times larger than the cap (or compaction
// still cannot fit a usable page), return a refine directive instead of a
// truncated dump. Override with QOBRIX_MCP_REFINE_MULTIPLIER.
function getRefineMultiplier(): number {
  const raw = process.env.QOBRIX_MCP_REFINE_MULTIPLIER;
  if (raw === undefined) return 8;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 1) return 8;
  return n;
}

const SAMPLE_ROWS = 5;

function isPaginatedListPayload(
  data: unknown
): data is { data: unknown[]; pagination?: Record<string, unknown>; [k: string]: unknown } {
  return (
    typeof data === "object" &&
    data !== null &&
    Array.isArray((data as { data?: unknown }).data)
  );
}

/** Drop nested objects/arrays (expand FK blobs, media arrays); keep scalars. */
export function compactRow(row: unknown): unknown {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    return row;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    if (v !== null && typeof v === "object") continue;
    out[k] = v;
  }
  return out;
}

/** Compact + clip long strings so refine samples stay under the output cap. */
function compactSampleRow(row: unknown, maxString = 80): unknown {
  const compacted = compactRow(row);
  if (
    compacted === null ||
    typeof compacted !== "object" ||
    Array.isArray(compacted)
  ) {
    return compacted;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(compacted as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > maxString) {
      out[k] = v.slice(0, maxString) + "…";
    } else {
      out[k] = v;
    }
  }
  return out;
}

function largestFittingPrefix(
  rows: unknown[],
  buildEnvelope: (kept: unknown[]) => unknown,
  max: number
): number {
  let lo = 0;
  let hi = rows.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = JSON.stringify(buildEnvelope(rows.slice(0, mid)), null, 2);
    if (candidate.length <= max) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function matchedEstimate(
  data: { data: unknown[]; pagination?: Record<string, unknown> },
  total: number
): number {
  const pag = data.pagination;
  if (pag && typeof pag.count === "number" && Number.isFinite(pag.count)) {
    return pag.count as number;
  }
  if (pag && typeof pag.scanned === "number" && Number.isFinite(pag.scanned)) {
    return pag.scanned as number;
  }
  return total;
}

function buildRefineEnvelope(
  data: { data: unknown[]; pagination?: Record<string, unknown>; [k: string]: unknown },
  sampleRows: unknown[],
  originalChars: number,
  max: number,
  reason: string
) {
  const total = data.data.length;
  return {
    status: "result_too_large",
    matched_estimate: matchedEstimate(data, total),
    returned_sample: sampleRows,
    _refine_required: {
      reason,
      assistant_instruction:
        "Do NOT dump this payload or invent missing rows. Tell the user the " +
        "query matched too many or too-large records for a single reply, ask " +
        "them to narrow it (filters, fields, smaller limit, no expand/media), " +
        "then retry with the tightened request.",
      suggested_narrowing: [
        "add filters (location, price range, status, bedrooms, listing type)",
        "request specific fields[] instead of expand=true",
        "set media=false and expand=false",
        "reduce limit (e.g. 10-20)",
      ],
      original_chars: originalChars,
      max_chars: max,
      total_rows_in_page: total,
    },
  };
}

export function formatResult(data: unknown) {
  const max = getMaxResultChars();
  const fullText = JSON.stringify(data, null, 2);

  if (max === 0 || fullText.length <= max) {
    const structured = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : { items: data, count: Array.isArray(data) ? data.length : 1 };
    return {
      content: [{ type: "text" as const, text: fullText }],
      structuredContent: structured,
    };
  }

  const originalChars = fullText.length;
  const refineMultiplier = getRefineMultiplier();
  const grosslyOversized = originalChars > refineMultiplier * max;

  // Smart truncation for paginated/list-shaped payloads: keep the largest
  // prefix of `data.data` that fits, attach a `_truncated` marker so the
  // caller knows to scope further (fields[], smaller limit, search filter).
  if (isPaginatedListPayload(data)) {
    const rows = data.data;
    const total = rows.length;

    const buildEnvelope = (
      kept: unknown[],
      extra?: { compacted?: boolean }
    ) => {
      const omitted = total - kept.length;
      return {
        ...data,
        data: kept,
        _truncated: {
          omitted_rows: omitted,
          kept_rows: kept.length,
          total_rows_in_page: total,
          original_chars: originalChars,
          max_chars: max,
          ...(extra?.compacted ? { compacted: true as const } : {}),
          hint:
            "Result truncated to fit MCP output cap. To get more rows per call, " +
            "pass fields[] to whitelist the columns you actually need, reduce " +
            "limit, or add a search filter. Use expand=false (default) and " +
            "media=false (default) to keep rows compact.",
        },
      };
    };

    let workingRows = rows;
    let compacted = false;
    let best = largestFittingPrefix(
      workingRows,
      (kept) => buildEnvelope(kept),
      max
    );

    // Fix 1: truncation cliff — every expanded/media row exceeds the cap alone.
    // Re-render scalar-only and retry; always keep >= 1 row when total > 0.
    if (best === 0 && total > 0) {
      workingRows = rows.map(compactRow);
      compacted = true;
      best = largestFittingPrefix(
        workingRows,
        (kept) => buildEnvelope(kept, { compacted: true }),
        max
      );
      if (best === 0) {
        best = 1;
      }
    }

    // Fix 1b: grossly oversized or compaction still cannot produce a usable page.
    const compactionUnusable = compacted && best <= 1 && total > 1;
    if (grosslyOversized || compactionUnusable) {
      const sample = rows.slice(0, SAMPLE_ROWS).map((r) => compactSampleRow(r));
      const reason = grosslyOversized
        ? "Payload far larger than the MCP output cap (expand/media or a broad query)."
        : "Even after compacting nested expand/media fields, only a tiny page fits the cap.";
      const envelope = buildRefineEnvelope(
        data,
        sample,
        originalChars,
        max,
        reason
      );
      let text = JSON.stringify(envelope, null, 2);
      // Guarantee the refine envelope itself stays under the cap.
      if (text.length > max) {
        for (const n of [3, 2, 1, 0]) {
          const tighter = buildRefineEnvelope(
            data,
            sample.slice(0, n),
            originalChars,
            max,
            reason
          );
          text = JSON.stringify(tighter, null, 2);
          if (text.length <= max) break;
        }
      }
      return {
        content: [
          {
            type: "text" as const,
            text,
          },
        ],
        isError: true as const,
      };
    }

    const text = JSON.stringify(
      buildEnvelope(workingRows.slice(0, best), compacted ? { compacted: true } : undefined),
      null,
      2
    );
    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  }

  // Grossly oversized non-paginated payloads → refine directive (no dump).
  if (grosslyOversized) {
    const text = JSON.stringify(
      {
        status: "result_too_large",
        _refine_required: {
          reason:
            "Single-object payload far larger than the MCP output cap.",
          assistant_instruction:
            "Do NOT dump this. Tell the user the record is too large for one reply " +
            "and ask them to narrow (fields[] / include[], drop expand/media), then retry.",
          suggested_narrowing: [
            "request specific fields[] or include[]",
            "set media=false and expand=false",
            "fetch related entities with a dedicated get/list tool",
          ],
          original_chars: originalChars,
          max_chars: max,
        },
      },
      null,
      2
    );
    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
      isError: true as const,
    };
  }

  // Fallback for single-object / custom-shape payloads: clip text and append
  // a structured trailer the LLM can recognise.
  const head = fullText.slice(0, Math.max(0, max - 400));
  const trailer =
    "\n\n... [QOBRIX_MCP TRUNCATED — original " +
    originalChars +
    " chars, cap " +
    max +
    " chars. " +
    "Use fields[] / include[] / a tighter search filter to scope the result. " +
    "Set expand=false (default) and media=false (default) to keep payloads compact.]";
  return {
    content: [
      {
        type: "text" as const,
        text: head + trailer,
      },
    ],
  };
}

export function errorResult(error: unknown) {
  // Let the SDK convert this to JSON-RPC -32042 for elicitation-capable clients.
  if (error instanceof UrlElicitationRequiredError) {
    throw error;
  }

  if (error instanceof AuthRequiredError) {
    return {
      content: [{ type: "text" as const, text: "Sign-in is required." }],
      structuredContent: { error: "Sign-in is required.", next_step: "Sign in again from the client. This server does not return a link." },
      isError: true as const,
    };
  }

  const message = error instanceof Error ? error.message : "An unknown error occurred";
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    structuredContent: { error: message, next_step: "Read the error, change the arguments, and call the tool again." },
    isError: true as const,
  };
}

export function registerTools(server: McpServer): void {
  registerPropertyTools(server);
  registerContactTools(server);
  registerAgentTools(server);
  registerOpportunityTools(server);
  registerViewingTools(server);
  registerTaskTools(server);
  registerMediaTools(server);
  registerProjectTools(server);
  registerOfferTools(server);
  registerContractTools(server);
  registerActivityTools(server);
  registerMetaTools(server);
  registerAnalyticsTools(server);
  registerDealTools(server);
  registerReportTools(server);
  registerPipelineTools(server);
  registerProductivityTools(server);
  registerCustomerTools(server);
  registerCacheTools(server);
  registerAuditTools(server);
  registerSessionTools(server);
}
