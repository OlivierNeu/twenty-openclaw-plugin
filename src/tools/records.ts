// Generic record tools — operate on ANY Twenty entity (standard or custom)
// by accepting the entity plural name as a tool parameter.
//
// Why a generic surface? P5 lets the agent create custom objects via the
// metadata API; without P6 the agent could shape the schema but not store
// records in it. These five tools complete the loop: list, get, create,
// update, delete on `/rest/<entity>`.
//
// Endpoint convention (verified against the Twenty REST OpenAPI on
// 2026-05-02 — same shape as `people`, `companies`, etc., applied to the
// caller-supplied `entity`):
//   - GET    /rest/<entity>              → { data: { <entity>: [...] }, pageInfo, totalCount }
//   - GET    /rest/<entity>/{id}         → { data: { <singular>: {...} } }
//   - POST   /rest/<entity>              → 201 { data: { create<Singular>: {...} } }
//   - PATCH  /rest/<entity>/{id}         → 200 { data: { update<Singular>: {...} } }
//   - DELETE /rest/<entity>/{id}         → 200 { data: { delete<Singular>: { id } }, soft-deleted by default }
//
// Singular wrapper key — DO NOT derive client-side. Twenty's capitalisation
// rules for custom objects do not boil down to a simple "strip the trailing
// s" (e.g. `people` → `person`, `icopeDiagnostics` → `icopeDiagnostic`).
// The list response wraps under the plural — which IS the entity we know —
// but the get/create/update/delete responses wrap under a singular form
// the agent never has to specify. We pick the only key under `data` after
// a successful response and surface its value. Twenty's REST contract
// guarantees exactly one key per write/get response, so this is safe.
//
// Security — entity validation BEFORE the network call:
//   - Twenty REST entities are camelCase identifiers (`people`, `companies`,
//     `icopeDiagnostics`). The regex `^[a-zA-Z][a-zA-Z0-9]*$` matches that
//     contract exactly: leading letter, alphanumerics only.
//   - The regex blocks path traversal (`people/../../etc/passwd`),
//     query-string injection (`people?role=admin`), and any other shell
//     metacharacter. We reject before the URL is built — `fetch` is never
//     called when the regex fails.
//
// Approval gating: only `twenty_record_delete` is approval-gated by default
// (mirrors the `*_delete` convention in P3 and the spec for P6 D3). Create
// and update are NOT gated — too noisy for the agent's day-to-day flow,
// and consistent with `twenty_people_create` / `twenty_people_update`.
//
// Read-only enforcement: `mutates: true` on create/update/delete causes
// the factory to throw `TwentyReadOnlyError` BEFORE any network call when
// the plugin is in read-only mode.
//
// No factory abstraction: the five tools are flat by design. Five 25-30
// line definitions read better than one 70-line generic builder, and the
// per-tool description can be hand-tuned for the model.

import { Type } from "@sinclair/typebox";

import { defineTwentyTool, shapeListResponse } from "./_factory.js";
import type { TwentyClient } from "../twenty-client.js";

// Anchored start-to-end so a substring like `..` or `/` cannot sneak in.
// Single capture matches the entire `entity` value or nothing.
const ENTITY_REGEX = /^[a-zA-Z][a-zA-Z0-9]*$/;

/**
 * Validate a caller-supplied entity name against the Twenty REST naming
 * contract. Throws a plain {@link Error} on mismatch; the tool factory's
 * catch surface translates it to `{ status: "failed", error: msg }`.
 *
 * Called BEFORE constructing the URL so a malicious `entity` value never
 * reaches the network — the test suite asserts `fetch` is not invoked
 * when the regex fails.
 */
function assertValidEntity(entity: string): void {
  if (typeof entity !== "string" || !ENTITY_REGEX.test(entity)) {
    throw new Error(
      `Invalid entity name: must match ^[a-zA-Z][a-zA-Z0-9]*$ ` +
        `(got: ${JSON.stringify(entity)})`,
    );
  }
}

/**
 * Twenty wraps every write/get response in a single keyed envelope:
 *   { data: { createPerson: {...} } }
 *   { data: { updateIcopeDiagnostic: {...} } }
 *   { data: { person: {...} } }            (get)
 *
 * Since we cannot derive the wrapper key from the plural entity reliably
 * for custom objects, we read the single key Twenty sets. Returns the
 * unwrapped record, or `null` if the response is empty.
 */
function unwrapSingleKeyed(resp: { data?: Record<string, unknown> } | null):
  | unknown
  | null {
  const wrap = resp?.data;
  if (!wrap || typeof wrap !== "object") return null;
  const keys = Object.keys(wrap);
  if (keys.length === 0) return null;
  // First key is the right one in practice (Twenty returns exactly one);
  // if Twenty ever adds sibling keys we still surface a useful payload.
  return wrap[keys[0]!] ?? null;
}

// ---------------------------------------------------------------------------
// Schemas — kept loose: list shares the standard pagination + filter contract,
// create/update accept an opaque body since the schema depends on the entity
// (and especially on custom object schemas the agent itself created via P5).
// Twenty validates server-side and returns actionable 400 errors.
// ---------------------------------------------------------------------------

const RecordListSchema = Type.Object({
  entity: Type.String({
    description:
      "Entity plural name (e.g. 'people', 'companies', 'icopeDiagnostics' " +
      "for custom objects). Must match `^[a-zA-Z][a-zA-Z0-9]*$`. Use " +
      "`twenty_metadata_objects_list` to discover available entities and " +
      "their `namePlural`.",
  }),
  // Re-declare the standard list inputs inline (rather than spreading
  // `ListInputSchema`) so the model sees `entity` first in the schema —
  // matches how it reasons about the call.
  limit: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 200,
      default: 60,
      description: "Number of records per page. Twenty default 60, max 200.",
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
        "Twenty filter DSL: `field[COMPARATOR]:value`. Comparators: eq, " +
        "neq, in, gt, gte, lt, lte, like, ilike, is, startsWith.",
    }),
  ),
  order_by: Type.Optional(
    Type.String({
      description:
        "Twenty order DSL: `field_name[DIRECTION]`. Direction: ASC (default) or DESC.",
    }),
  ),
  depth: Type.Optional(
    Type.Union([Type.Literal(0), Type.Literal(1)], {
      description:
        "0 = primary object only; 1 = include direct relations. Default 1.",
    }),
  ),
});

const RecordGetSchema = Type.Object({
  entity: Type.String({
    description:
      "Entity plural name (e.g. 'people'). Must match `^[a-zA-Z][a-zA-Z0-9]*$`.",
  }),
  id: Type.String({ description: "Record UUID" }),
  depth: Type.Optional(
    Type.Union([Type.Literal(0), Type.Literal(1)], {
      description:
        "0 = primary object only; 1 = include direct relations. Default 1.",
    }),
  ),
});

const RecordCreateSchema = Type.Object({
  entity: Type.String({
    description:
      "Entity plural name (e.g. 'people'). Must match `^[a-zA-Z][a-zA-Z0-9]*$`.",
  }),
  data: Type.Object(
    {},
    {
      additionalProperties: true,
      description:
        "Record fields. Schema depends on the entity. Use " +
        "`twenty_metadata_fields_list({objectMetadataId: '<obj_id>'})` to " +
        "discover required/available fields. Twenty validates server-side " +
        "and returns actionable error messages.",
    },
  ),
});

const RecordUpdateSchema = Type.Object({
  entity: Type.String({
    description:
      "Entity plural name (e.g. 'people'). Must match `^[a-zA-Z][a-zA-Z0-9]*$`.",
  }),
  id: Type.String({ description: "Record UUID to update" }),
  data: Type.Object(
    {},
    {
      additionalProperties: true,
      description:
        "Record fields to patch. PATCH semantics — only supplied fields " +
        "are modified. Schema depends on the entity (see " +
        "`twenty_metadata_fields_list`).",
    },
  ),
});

const RecordDeleteSchema = Type.Object({
  entity: Type.String({
    description:
      "Entity plural name (e.g. 'people'). Must match `^[a-zA-Z][a-zA-Z0-9]*$`.",
  }),
  id: Type.String({ description: "Record UUID to delete" }),
});

// ---------------------------------------------------------------------------
// Tool definitions — flat by design (5×~30 lines beats 1×70-line factory).
// ---------------------------------------------------------------------------

export function buildRecordTools(client: TwentyClient) {
  return [
    defineTwentyTool(
      {
        name: "twenty_record_list",
        description:
          "List records of ANY Twenty entity (standard or custom). Pass the " +
          "entity plural name (`people`, `companies`, `icopeDiagnostics` for " +
          "a custom object). Returns up to `limit` records (default 60, max " +
          "200) with cursor-based pagination via `pageInfo.endCursor`. " +
          "Filter and order DSL identical to the per-entity tools " +
          "(`twenty_people_list`, ...).",
        parameters: RecordListSchema,
        run: async (params, c, signal) => {
          assertValidEntity(params.entity);
          const query: Record<string, string | number | boolean | undefined> = {
            limit: params.limit,
            startingAfter: params.starting_after,
            endingBefore: params.ending_before,
            filter: params.filter,
            orderBy: params.order_by,
            depth: params.depth,
          };
          const resp = await c.request<{
            data?: Record<string, unknown>;
            pageInfo?: {
              hasNextPage?: boolean;
              startCursor?: string | null;
              endCursor?: string | null;
            };
            totalCount?: number;
          }>("GET", `/rest/${params.entity}`, { query, signal });
          // The list wrapper key is the plural entity itself — same string
          // we put in the path. `shapeListResponse` knows how to unwrap.
          return shapeListResponse(resp, params.entity);
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_record_get",
        description:
          "Fetch a single record of ANY Twenty entity by UUID. Pass the " +
          "entity plural name + record id. Includes direct relations when " +
          "`depth=1` (default).",
        parameters: RecordGetSchema,
        run: async (params, c, signal) => {
          assertValidEntity(params.entity);
          const resp = await c.request<{ data?: Record<string, unknown> }>(
            "GET",
            `/rest/${params.entity}/${encodeURIComponent(params.id)}`,
            { query: { depth: params.depth }, signal },
          );
          return unwrapSingleKeyed(resp);
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_record_create",
        description:
          "Create a record of ANY Twenty entity. Pass the entity plural name " +
          "and a `data` object with the record fields. Schema depends on the " +
          "entity — call `twenty_metadata_fields_list({objectMetadataId})` " +
          "first if unsure. Twenty validates server-side and returns " +
          "actionable errors when fields are missing or invalid.",
        mutates: true,
        parameters: RecordCreateSchema,
        run: async (params, c, signal) => {
          assertValidEntity(params.entity);
          const resp = await c.request<{ data?: Record<string, unknown> }>(
            "POST",
            `/rest/${params.entity}`,
            { body: params.data, signal },
          );
          return unwrapSingleKeyed(resp);
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_record_update",
        description:
          "Update a record of ANY Twenty entity by UUID (PATCH semantics — " +
          "only supplied fields are modified). Pass the entity plural name, " +
          "the record id, and a `data` object with the fields to update.",
        mutates: true,
        parameters: RecordUpdateSchema,
        run: async (params, c, signal) => {
          assertValidEntity(params.entity);
          const resp = await c.request<{ data?: Record<string, unknown> }>(
            "PATCH",
            `/rest/${params.entity}/${encodeURIComponent(params.id)}`,
            { body: params.data, signal },
          );
          return unwrapSingleKeyed(resp);
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_record_delete",
        description:
          "Soft-delete a record of ANY Twenty entity by UUID. The record is " +
          "kept in the database with a `deletedAt` timestamp and is no " +
          "longer returned by `twenty_record_list` / `twenty_record_get`. " +
          "Recoverable through the Twenty UI. " +
          "This tool requires approval by default (see `approvalRequired`).",
        mutates: true,
        parameters: RecordDeleteSchema,
        run: async (params, c, signal) => {
          assertValidEntity(params.entity);
          const resp = await c.request<{ data?: Record<string, unknown> }>(
            "DELETE",
            `/rest/${params.entity}/${encodeURIComponent(params.id)}`,
            // Snake-case on the wire per Twenty's OpenAPI; matches
            // `buildDeleteTool` behaviour for the per-entity *_delete tools.
            { query: { soft_delete: true }, signal },
          );
          const unwrapped = unwrapSingleKeyed(resp);
          return unwrapped ?? { id: params.id };
        },
      },
      client,
    ),
  ];
}
