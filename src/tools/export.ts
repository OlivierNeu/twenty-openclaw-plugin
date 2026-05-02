// Twenty bulk export (`twenty_export`) — paginates an entire collection
// and returns it as JSON or CSV.
//
// This tool is intentionally NOT in the `_factory.ts` set because it
// orchestrates multiple HTTP calls (a pagination loop) and produces a
// composite payload. Every other Twenty tool maps 1:1 onto a single REST
// endpoint; the factory abstractions don't fit a multi-call orchestrator.
//
// Caps and conventions:
//   - The pagination loop drives `client.request<RawTwentyListResponse>` directly.
//   - Pagination uses Twenty's wire-format query keys: `limit`, `startingAfter`
//     (camelCase). The factory's `listInputToQuery` does the snake→camel
//     translation for the standard list tools — we do it inline here.
//   - The `entity` enum is restricted to the five domain entities P3 covers:
//     people, companies, opportunities, notes, tasks. Adding a new entity
//     requires a one-line tweak — kept intentionally narrow so the agent
//     can't ask for activities/metadata exports we don't model.
//   - `max_records` defaults to 1000 and tops out at 10000 to keep the
//     in-memory representation bounded. For larger exports the agent
//     should fall back to the per-entity `*_list` tools with explicit
//     pagination.
//   - CSV escaping is inline (~30 lines, no `papaparse`/`csv-stringify`
//     dependency added per P4a scope discipline). Nested objects are
//     flattened with dot-notation (`name.firstName`, `address.addressCity`).

import { Type, type Static } from "@sinclair/typebox";

import {
  defineTwentyTool,
  shapeListResponse,
  type ListOutput,
} from "./_factory.js";
import type { TwentyClient } from "../twenty-client.js";

const ENTITY_TO_KEY: Record<string, string> = {
  people: "people",
  companies: "companies",
  opportunities: "opportunities",
  notes: "notes",
  tasks: "tasks",
};

const ENTITY_NAMES = Object.keys(ENTITY_TO_KEY) as Array<
  keyof typeof ENTITY_TO_KEY
>;

const MAX_RECORDS_HARD_CAP = 10_000;
const PAGE_LIMIT = 60; // Twenty's REST default

const ExportInputSchema = Type.Object({
  entity: Type.Union(
    ENTITY_NAMES.map((n) => Type.Literal(n)),
    {
      description:
        "Twenty object type to export. One of: " + ENTITY_NAMES.join(", "),
    },
  ),
  format: Type.Optional(
    Type.Union([Type.Literal("json"), Type.Literal("csv")], {
      default: "json",
      description:
        "Output format. `json` returns the raw record array; `csv` " +
        "flattens nested objects with dot-notation column headers.",
    }),
  ),
  filter: Type.Optional(
    Type.String({
      description:
        "Optional Twenty filter DSL — same shape as `*_list` tools. " +
        "Example: `createdAt[gte]:2026-01-01`.",
    }),
  ),
  max_records: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_RECORDS_HARD_CAP,
      default: 1000,
      description:
        `Hard cap on the number of records to return (default 1000, max ` +
        `${MAX_RECORDS_HARD_CAP}). The pagination loop stops as soon as ` +
        `the cap is hit, even if Twenty has more pages.`,
    }),
  ),
});

type ExportInput = Static<typeof ExportInputSchema>;

interface RawTwentyListResponseShape {
  data?: Record<string, unknown>;
  pageInfo?: {
    hasNextPage?: boolean;
    startCursor?: string | null;
    endCursor?: string | null;
  };
  totalCount?: number;
}

/**
 * Walk the keys of every record and return the union, deeply flattened
 * with dot-notation. Order is stabilised by first-seen — useful for
 * predictable CSV column order across calls. Arrays and nested values
 * that are not plain objects (e.g. dates, primitives) are surfaced under
 * their dotted parent key directly.
 */
function collectFlatColumns(records: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];

  function walk(value: unknown, prefix: string) {
    if (value === null || value === undefined) {
      if (prefix && !seen.has(prefix)) {
        seen.add(prefix);
        order.push(prefix);
      }
      return;
    }
    if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Date)
    ) {
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj);
      if (keys.length === 0 && prefix && !seen.has(prefix)) {
        seen.add(prefix);
        order.push(prefix);
        return;
      }
      for (const k of keys) {
        const next = prefix ? `${prefix}.${k}` : k;
        walk(obj[k], next);
      }
      return;
    }
    // Primitive, array, or Date — leaf.
    if (prefix && !seen.has(prefix)) {
      seen.add(prefix);
      order.push(prefix);
    }
  }

  for (const r of records) walk(r, "");
  return order;
}

/**
 * Resolve a dotted column path against a record. Returns the leaf value
 * (or `undefined` if any segment is missing). Mirrors the path semantics
 * of {@link collectFlatColumns}.
 */
function resolvePath(record: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = record;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/**
 * Serialise a leaf value into a CSV-safe cell. Strings containing `,`,
 * `"`, `\n`, or `\r` are quoted with internal double-quotes escaped. Null
 * and undefined become empty cells. Arrays and objects (e.g. lists of
 * tags, JSON sub-trees) are JSON-stringified — matches the agent's
 * expectations from prior P3 round-trips.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (typeof value === "string") {
    s = value;
  } else if (typeof value === "number" || typeof value === "boolean") {
    s = String(value);
  } else if (value instanceof Date) {
    s = value.toISOString();
  } else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function recordsToCsv(records: Record<string, unknown>[]): string {
  if (records.length === 0) return "";
  const columns = collectFlatColumns(records);
  const lines: string[] = [];
  lines.push(columns.map(csvCell).join(","));
  for (const r of records) {
    const row = columns.map((c) => csvCell(resolvePath(r, c)));
    lines.push(row.join(","));
  }
  // Trailing newline keeps the file POSIX-friendly when the agent pipes
  // it into a tool that strips trailing whitespace.
  return lines.join("\n") + "\n";
}

/**
 * Pagination loop: walks `GET /rest/<entity>` cursors until either
 * `pageInfo.hasNextPage` is false or `records.length >= maxRecords`.
 *
 * Returns the accumulated records (capped at `maxRecords`) plus the last
 * `pageInfo` snapshot for diagnostics.
 */
async function paginateAll(
  client: TwentyClient,
  entityKey: string,
  filter: string | undefined,
  maxRecords: number,
  signal: AbortSignal | undefined,
): Promise<{ records: Record<string, unknown>[]; pages: number }> {
  const path = `/rest/${entityKey}`;
  const records: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  let pages = 0;

  while (records.length < maxRecords) {
    const query: Record<string, string | number | boolean | undefined> = {
      limit: PAGE_LIMIT,
      filter,
    };
    if (cursor) query.startingAfter = cursor;

    const resp = await client.request<RawTwentyListResponseShape>(
      "GET",
      path,
      { query, signal },
    );
    pages += 1;
    const shaped: ListOutput<Record<string, unknown>> =
      shapeListResponse<Record<string, unknown>>(resp, entityKey);

    for (const r of shaped.data) {
      records.push(r);
      if (records.length >= maxRecords) break;
    }

    if (!shaped.pageInfo.hasNextPage || !shaped.pageInfo.endCursor) break;
    cursor = shaped.pageInfo.endCursor;
  }

  return { records, pages };
}

export function buildExportTools(client: TwentyClient) {
  return [
    defineTwentyTool(
      {
        name: "twenty_export",
        description:
          "Export all records of a given Twenty object type to JSON or CSV " +
          "format. Auto-paginates through the entire collection (60 records " +
          "per page). Returns the full dataset in memory — for huge " +
          `workspaces consider using \`*_list\` with manual pagination ` +
          `instead. Hard cap: ${MAX_RECORDS_HARD_CAP} records.`,
        parameters: ExportInputSchema,
        run: async (params: ExportInput, c, signal) => {
          const format = params.format ?? "json";
          const maxRecords = Math.min(
            params.max_records ?? 1000,
            MAX_RECORDS_HARD_CAP,
          );
          const entityKey = ENTITY_TO_KEY[params.entity];
          if (!entityKey) {
            throw new Error(
              `twenty_export: unsupported entity "${params.entity}"`,
            );
          }
          const { records, pages } = await paginateAll(
            c,
            entityKey,
            params.filter,
            maxRecords,
            signal,
          );

          if (format === "csv") {
            return {
              format: "csv" as const,
              entity: params.entity,
              count: records.length,
              pages,
              data: recordsToCsv(records),
            };
          }
          return {
            format: "json" as const,
            entity: params.entity,
            count: records.length,
            pages,
            data: records,
          };
        },
      },
      client,
    ),
  ];
}
