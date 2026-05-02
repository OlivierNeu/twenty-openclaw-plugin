// Tool factory shared across every Twenty tool.
//
// The factory standardises:
//   - JSON serialisation of the tool result
//   - Error mapping (TwentyApiError, TwentyWorkspaceNotAllowedError,
//     TwentyReadOnlyError → tool failure)
//   - The `execute(toolCallId, params, signal)` signature expected by the
//     OpenClaw runtime
//
// Each domain file (workspace, people, companies, ...) declares its tools
// by calling {@link defineTwentyTool} (single tool) or
// {@link buildListTool} / {@link buildGetByIdTool} (the two patterns shared
// across every domain that follows Twenty's REST list/get conventions).
// The entry point collects all returned arrays and registers them in bulk.

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import {
  TwentyApiError,
  TwentyReadOnlyError,
  TwentyWorkspaceNotAllowedError,
  type TwentyClient,
} from "../twenty-client.js";

/**
 * Definition for a single Twenty tool. Generic over the TypeBox schema so
 * the `execute` body sees fully typed params.
 *
 * - `name` is the tool identifier exposed to the LLM. Convention:
 *   `twenty_<domain>_<verb>` (e.g. `twenty_people_create`).
 * - `description` is what the model sees. Keep it short and unambiguous;
 *   mention any required parameters the model is likely to forget.
 * - `parameters` is a TypeBox `Type.Object(...)` schema.
 * - `mutates` (default `false`) marks tools that write or delete data.
 *   When `true`, the factory rejects the call early if the client is in
 *   read-only mode.
 * - `run(params, client, signal)` does the actual API call. Returning a
 *   value (any JSON-serialisable shape) is enough — the factory wraps it
 *   as a text tool result for the model.
 */
export interface TwentyToolDefinition<TSchema_ extends TSchema> {
  name: string;
  description: string;
  parameters: TSchema_;
  label?: string;
  mutates?: boolean;
  run: (
    params: Static<TSchema_>,
    client: TwentyClient,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

/**
 * Wrap a {@link TwentyToolDefinition} into the `AgentTool` shape consumed
 * by `api.registerTool`. Captured in a closure so `client` is bound once
 * at plugin registration time.
 */
export function defineTwentyTool<TSchema_ extends TSchema>(
  def: TwentyToolDefinition<TSchema_>,
  client: TwentyClient,
): {
  name: string;
  description: string;
  label: string;
  parameters: TSchema_;
  execute: (
    toolCallId: string,
    params: Static<TSchema_>,
    signal?: AbortSignal,
  ) => Promise<
    AgentToolResult<{ status: "ok" | "failed"; data?: unknown; error?: string }>
  >;
} {
  const label = def.label ?? def.name;
  const mutates = def.mutates === true;

  return {
    name: def.name,
    description: def.description,
    label,
    parameters: def.parameters,
    async execute(_toolCallId, params, signal) {
      try {
        if (mutates && client.readOnly) {
          throw new TwentyReadOnlyError(def.name);
        }
        const data = await def.run(params, client, signal);
        const text =
          data === null || data === undefined
            ? "OK"
            : typeof data === "string"
              ? data
              : JSON.stringify(data, null, 2);
        return {
          content: [{ type: "text", text }],
          details: { status: "ok", data },
        };
      } catch (err) {
        // Distinguish whitelist violations and read-only refusals from
        // generic Twenty errors so the model can react accordingly (and
        // so tests can assert).
        if (err instanceof TwentyWorkspaceNotAllowedError) {
          return {
            content: [{ type: "text", text: `Refused: ${err.message}` }],
            details: { status: "failed", error: err.message },
          };
        }
        if (err instanceof TwentyReadOnlyError) {
          return {
            content: [{ type: "text", text: `Refused: ${err.message}` }],
            details: { status: "failed", error: err.message },
          };
        }
        if (err instanceof TwentyApiError) {
          return {
            content: [
              {
                type: "text",
                text: `Twenty API error (${err.status}): ${err.bodyPreview.slice(0, 300)}`,
              },
            ],
            details: { status: "failed", error: err.message },
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          details: { status: "failed", error: msg },
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Shared list / get-by-id helpers — applied uniformly across every domain.
//
// Twenty's list endpoints return:
//   { data: { <entityKey>: TItem[] }, pageInfo, totalCount }
// Twenty's by-id endpoints return:
//   { data: { <entityKeySingular>: TItem } }
//
// The helpers unwrap to a uniform output shape so domain files are 15-30
// lines each and the agent always sees the same envelope.
// ---------------------------------------------------------------------------

/**
 * Standardised input schema for every Twenty list tool.
 *
 * Snake-case is the public contract surfaced to the model (`starting_after`,
 * `ending_before`, `order_by`); the helper translates to camelCase before
 * hitting the Twenty API.
 *
 * `filter` and `order_by` are strings because Twenty's REST API accepts a
 * DSL string (e.g. `"firstName[eq]:John,emails.primaryEmail[ilike]:%@acme.com%"`
 * for filter, `"createdAt,name[DESC]"` for order). The model picks the
 * fields and the wire shape — we don't translate.
 *
 * Limits per OpenAPI: minimum 0, maximum 200, default 60. We expose the
 * full Twenty range; the model can be conservative.
 */
export const ListInputSchema = Type.Object({
  limit: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 200,
      default: 60,
      description:
        "Number of records to return per page. Twenty default 60, max 200.",
    }),
  ),
  starting_after: Type.Optional(
    Type.String({
      description:
        "Cursor for the next page. Pass `pageInfo.endCursor` from the previous response.",
    }),
  ),
  ending_before: Type.Optional(
    Type.String({
      description:
        "Cursor for the previous page. Pass `pageInfo.startCursor` from the previous response.",
    }),
  ),
  filter: Type.Optional(
    Type.String({
      description:
        'Twenty filter DSL: `field[COMPARATOR]:value,field2[COMPARATOR]:value2`. ' +
        'Comparators: eq, neq, in, gt, gte, lt, lte, like, ilike, is, startsWith. ' +
        'Examples: `firstName[eq]:John`, `emails.primaryEmail[ilike]:%@acme.com%`, ' +
        '`createdAt[gte]:2026-01-01`. For `like`/`ilike`, use `%` wildcards.',
    }),
  ),
  order_by: Type.Optional(
    Type.String({
      description:
        "Twenty order DSL: `field_name_1,field_name_2[DIRECTION_2]`. " +
        "Direction is `ASC` (default) or `DESC`. Example: `createdAt[DESC]`.",
    }),
  ),
  depth: Type.Optional(
    Type.Union([Type.Literal(0), Type.Literal(1)], {
      description:
        "0 = primary object only; 1 = include direct relations. Default 1.",
    }),
  ),
});

export type ListInput = Static<typeof ListInputSchema>;

/**
 * Uniform output envelope for every list tool. The agent decides when to
 * page based on `pageInfo.hasNextPage` + `pageInfo.endCursor`.
 */
export interface ListOutput<TItem> {
  data: TItem[];
  pageInfo: {
    hasNextPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  };
  totalCount: number | null;
}

/**
 * Raw shape Twenty returns for every list endpoint. The `data[entityKey]`
 * array lives one level deeper than the agent-facing contract — the
 * helper unwraps it.
 */
interface RawTwentyListResponse {
  data?: Record<string, unknown>;
  pageInfo?: {
    hasNextPage?: boolean;
    startCursor?: string | null;
    endCursor?: string | null;
  };
  totalCount?: number;
}

/**
 * Translate the snake-case agent input to the camelCase Twenty query
 * params. Drops undefined values so the request URL stays clean.
 */
function listInputToQuery(
  input: ListInput,
): Record<string, string | number | boolean | undefined> {
  return {
    limit: input.limit,
    startingAfter: input.starting_after,
    endingBefore: input.ending_before,
    filter: input.filter,
    orderBy: input.order_by,
    depth: input.depth,
  };
}

/**
 * Build a list tool wrapping a Twenty `GET /<entityKey>` endpoint.
 *
 * - `path` is the URL path (e.g. `/people`, `/companies`).
 * - `entityKey` is the array key Twenty wraps the records under
 *   (e.g. `people`, `companies`, `opportunities`, `notes`, `tasks`).
 * - `defaultDepth` overrides the Twenty default (1) when the tool needs
 *   shallow records by default (currently unused, kept for future helpers).
 */
export function buildListTool<TItem = unknown>(
  client: TwentyClient,
  spec: {
    name: string;
    description: string;
    path: string;
    entityKey: string;
    defaultDepth?: 0 | 1;
  },
) {
  return defineTwentyTool(
    {
      name: spec.name,
      description: spec.description,
      parameters: ListInputSchema,
      run: async (params, c, signal) => {
        const query = listInputToQuery(params);
        if (query.depth === undefined && spec.defaultDepth !== undefined) {
          query.depth = spec.defaultDepth;
        }
        const resp = await c.request<RawTwentyListResponse>(
          "GET",
          spec.path,
          { query, signal },
        );
        return shapeListResponse<TItem>(resp, spec.entityKey);
      },
    },
    client,
  );
}

/**
 * Coerce a Twenty list response into the uniform {@link ListOutput} shape.
 * Exported for use in tools that compose multiple Twenty calls (e.g.
 * `twenty_activities_list_for`).
 */
export function shapeListResponse<TItem>(
  resp: RawTwentyListResponse | null,
  entityKey: string,
): ListOutput<TItem> {
  const rawArray = resp?.data?.[entityKey];
  const items = Array.isArray(rawArray) ? (rawArray as TItem[]) : [];
  const pi = resp?.pageInfo ?? {};
  return {
    data: items,
    pageInfo: {
      hasNextPage: pi.hasNextPage === true,
      startCursor: pi.startCursor ?? null,
      endCursor: pi.endCursor ?? null,
    },
    totalCount: typeof resp?.totalCount === "number" ? resp.totalCount : null,
  };
}

/**
 * Build a get-by-id tool wrapping a Twenty `GET /<entityKey>/{id}` endpoint.
 *
 * - `path` is the URL path WITHOUT the trailing `/{id}` (the helper
 *   appends it after URL-encoding the id).
 * - `entityKeySingular` is the singular key Twenty wraps the record under
 *   (e.g. `person`, `company`, `opportunity`).
 *
 * Returns the unwrapped record directly (no envelope) so the agent gets
 * the same shape regardless of the entity.
 */
export function buildGetByIdTool<TItem = unknown>(
  client: TwentyClient,
  spec: {
    name: string;
    description: string;
    path: string;
    entityKeySingular: string;
  },
) {
  return defineTwentyTool(
    {
      name: spec.name,
      description: spec.description,
      parameters: Type.Object({
        id: Type.String({ description: "Record UUID" }),
        depth: Type.Optional(
          Type.Union([Type.Literal(0), Type.Literal(1)], {
            description:
              "0 = primary object only; 1 = include direct relations. Default 1.",
          }),
        ),
      }),
      run: async (params, c, signal) => {
        const resp = await c.request<{ data?: Record<string, unknown> }>(
          "GET",
          `${spec.path}/${encodeURIComponent(params.id)}`,
          { query: { depth: params.depth }, signal },
        );
        const record = resp?.data?.[spec.entityKeySingular];
        return (record as TItem | undefined) ?? null;
      },
    },
    client,
  );
}
