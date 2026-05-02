// Twenty Metadata API tools — manage custom objects and custom fields.
//
// Verified empirically against `https://crm.lacneu.com/rest/metadata/*` on
// 2026-05-02 (P5 live tests):
//   - Base path:           `/rest/metadata/objects`, `/rest/metadata/fields`
//                          (the metadata OpenAPI declares `servers.url =
//                          /rest/metadata` and paths `/objects`, `/fields`)
//   - GET    /metadata/objects             → { data: { objects: [...] }, pageInfo }
//                                            NO query params accepted (limit/filter
//                                            return 400). Returns ALL objects in
//                                            the workspace; agent filters in-memory.
//   - GET    /metadata/objects/{id}        → { data: { object: {...} } }
//                                            Includes `fields[]` inline.
//   - POST   /metadata/objects             → 201 { data: { createOneObject: {...} } }
//                                            Wrapper key has the `One` infix that
//                                            differs from the core REST API.
//   - PATCH  /metadata/objects/{id}        → 200 { data: { updateOneObject: {...} } }
//   - DELETE /metadata/objects/{id}        → 200 { data: { deleteOneObject: { id } } }
//                                            HARD delete — the object and ALL its
//                                            records are dropped. NO soft-delete
//                                            semantics (passing `?soft_delete=true`
//                                            triggers a 400 because the query string
//                                            is parsed as part of the UUID).
//   - GET    /metadata/fields              → { data: { fields: [...] }, pageInfo }
//                                            No query params accepted; the response
//                                            does NOT include `objectMetadataId` so
//                                            client-side filtering by parent object
//                                            requires GET /objects/{id} (which
//                                            inlines the fields[]).
//   - GET    /metadata/fields/{id}         → { data: { field: {...} } }
//   - POST   /metadata/fields              → 201 { data: { createOneField: {...} } }
//   - PATCH  /metadata/fields/{id}         → 200 { data: { updateOneField: {...} } }
//   - DELETE /metadata/fields/{id}         → 200 { data: { deleteOneField: { id } } }
//                                            Also HARD delete (the field and all
//                                            its column data are dropped).
//
// Schema-regeneration timing: confirmed synchronous on 2026-05-02 — after
// `POST /metadata/objects` returns, `GET /rest/<plural>` is reachable on the
// FIRST poll (~58ms, single attempt). No retry/polling logic is required
// in `metadata_object_create`. The new object is immediately usable through
// the future P6 generic record tools.
//
// Field schema design (D1): the `type` field is a free string and the
// `options`/`settings`/`relationCreationPayload` fields are opaque objects.
// Twenty validates them server-side and returns actionable 400 errors that
// surface verbatim to the model. This keeps the schema short and supports
// every Twenty field type (TEXT, NUMBER, DATE, RELATION, SELECT,
// MULTI_SELECT, BOOLEAN, CURRENCY, EMAILS, PHONES, LINKS, RATING, ADDRESS,
// FULL_NAME, RICH_TEXT, RAW_JSON, ACTOR, ARRAY, FILES, DATE_TIME, NUMERIC,
// MORPH_RELATION, POSITION, TS_VECTOR, UUID — see metadata OpenAPI for the
// authoritative enum) without burdening the model with a discriminated
// union it would have to learn anyway.

import { Type } from "@sinclair/typebox";

import { defineTwentyTool } from "./_factory.js";
import type { TwentyClient } from "../twenty-client.js";
import type {
  TwentyMetadataField,
  TwentyMetadataObject,
} from "../types.js";

const METADATA_OBJECTS_PATH = "/rest/metadata/objects";
const METADATA_FIELDS_PATH = "/rest/metadata/fields";

// Permissive icon naming guidance — Twenty uses Tabler icons (`IconUser`,
// `IconBuildingSkyscraper`, ...). We surface the convention in descriptions
// rather than enforcing a regex.

// ---------------------------------------------------------------------------
// Schemas — kept loose so the agent can drive every Twenty field type with
// the same tool surface. Naming constraints (camelCase singular,
// derived plural) are enforced server-side; the description guides the
// model without a strict regex that would block legitimate variants.
// ---------------------------------------------------------------------------

const ObjectCreateSchema = Type.Object({
  nameSingular: Type.String({
    description:
      "camelCase singular API name (e.g. 'coachingProgram'). Twenty enforces uniqueness and naming rules — invalid values return a 400 with details.",
  }),
  namePlural: Type.String({
    description:
      "camelCase plural API name (e.g. 'coachingPrograms'). Must NOT collide with existing objects.",
  }),
  labelSingular: Type.String({
    description: "Human-readable singular label (e.g. 'Coaching Program').",
  }),
  labelPlural: Type.String({
    description: "Human-readable plural label (e.g. 'Coaching Programs').",
  }),
  description: Type.Optional(Type.String()),
  icon: Type.Optional(
    Type.String({
      description:
        "Tabler icon name (e.g. 'IconUser', 'IconBuildingSkyscraper'). See https://tabler-icons.io/.",
    }),
  ),
  labelIdentifierFieldMetadataId: Type.Optional(
    Type.String({
      description:
        "UUID of the field used as the object's display label. Optional; Twenty assigns 'name' by default.",
    }),
  ),
  imageIdentifierFieldMetadataId: Type.Optional(Type.String()),
});

const ObjectUpdateSchema = Type.Object({
  id: Type.String({ description: "Object UUID to update" }),
  // All fields are optional on update — Twenty PATCH semantics apply.
  nameSingular: Type.Optional(Type.String()),
  namePlural: Type.Optional(Type.String()),
  labelSingular: Type.Optional(Type.String()),
  labelPlural: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  icon: Type.Optional(Type.String()),
  labelIdentifierFieldMetadataId: Type.Optional(Type.String()),
  imageIdentifierFieldMetadataId: Type.Optional(Type.String()),
  isActive: Type.Optional(
    Type.Boolean({
      description:
        "Toggle the object on/off without deleting it. Inactive objects are hidden from the UI and from `/rest/<plural>` queries.",
    }),
  ),
});

const FieldCreateSchema = Type.Object({
  objectMetadataId: Type.String({
    description: "UUID of the parent object the field belongs to.",
  }),
  type: Type.String({
    description:
      "Field type. Common values: TEXT, NUMBER, BOOLEAN, DATE, DATE_TIME, " +
      "EMAILS, PHONES, LINKS, RICH_TEXT, RATING, CURRENCY, SELECT, " +
      "MULTI_SELECT, RELATION, MORPH_RELATION, ADDRESS, FULL_NAME, " +
      "RAW_JSON, ACTOR, ARRAY, FILES, NUMERIC, POSITION, TS_VECTOR, UUID. " +
      "Twenty validates the value server-side; invalid types return a 400.",
  }),
  name: Type.String({
    description:
      "camelCase API name (e.g. 'firstName', 'totalRevenue'). Must be unique within the object.",
  }),
  label: Type.String({ description: "Human-readable label." }),
  description: Type.Optional(Type.String()),
  icon: Type.Optional(
    Type.String({
      description: "Tabler icon name (e.g. 'IconAbc', 'IconCalendar').",
    }),
  ),
  defaultValue: Type.Optional(
    Type.Unknown({
      description:
        "Type-specific default value. Examples: a string for TEXT, a number for NUMBER, an ISO 8601 date string for DATE, an object `{ amountMicros, currencyCode }` for CURRENCY. Twenty validates the shape.",
    }),
  ),
  isNullable: Type.Optional(Type.Boolean()),
  // Type-specific configuration — kept opaque so every Twenty field type
  // is reachable without a discriminated union. Twenty validates the shape
  // and returns actionable 400 errors when the payload is malformed.
  options: Type.Optional(
    Type.Array(
      Type.Object(
        {
          color: Type.Optional(Type.String()),
          label: Type.Optional(Type.String()),
          // Twenty enforces a `^[A-Z0-9]+_[A-Z0-9]+$` pattern on `value`.
          // We surface the convention in the description rather than via
          // a regex so the agent gets a clean 400 from Twenty if it slips.
          value: Type.Optional(
            Type.String({
              description:
                "Enum option key, must match `^[A-Z0-9]+_[A-Z0-9]+$` (e.g. 'OPTION_1').",
            }),
          ),
          position: Type.Optional(Type.Number()),
        },
        { additionalProperties: true },
      ),
      {
        description:
          "Enum options for SELECT or MULTI_SELECT field types. Each entry: { value: 'OPTION_KEY', label, color, position }.",
      },
    ),
  ),
  settings: Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: true,
        description:
          "Type-specific configuration (e.g. `{ relationType: 'MANY_TO_ONE', onDelete: 'SET_NULL' }` for RELATION). Twenty validates the shape per field type.",
      },
    ),
  ),
  relationCreationPayload: Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: true,
        description:
          "RELATION field only: { targetObjectMetadataId, type, targetFieldLabel, targetFieldIcon }. Required when `type` is RELATION or MORPH_RELATION.",
      },
    ),
  ),
});

const FieldUpdateSchema = Type.Object({
  id: Type.String({ description: "Field UUID to update" }),
  name: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  icon: Type.Optional(Type.String()),
  defaultValue: Type.Optional(Type.Unknown()),
  isActive: Type.Optional(Type.Boolean()),
  isNullable: Type.Optional(Type.Boolean()),
  options: Type.Optional(
    Type.Array(
      Type.Object(
        {
          color: Type.Optional(Type.String()),
          label: Type.Optional(Type.String()),
          value: Type.Optional(Type.String()),
          position: Type.Optional(Type.Number()),
        },
        { additionalProperties: true },
      ),
    ),
  ),
  settings: Type.Optional(Type.Object({}, { additionalProperties: true })),
});

// ---------------------------------------------------------------------------
// Helpers — small wrappers around `defineTwentyTool` since the metadata
// API uses different response wrapper keys (`createOneObject`, ...) than
// the rest of Twenty (`createPerson`, ...) and the shared write factories
// in `_factory.ts` are tied to the latter convention.
// ---------------------------------------------------------------------------

interface MetadataListResponse<TItem> {
  data?: Record<string, TItem[]>;
  pageInfo?: {
    hasNextPage?: boolean;
    startCursor?: string | null;
    endCursor?: string | null;
  };
  totalCount?: number;
}

interface MetadataGetResponse<TItem> {
  data?: Record<string, TItem>;
}

interface MetadataWriteResponse<TItem> {
  data?: Record<string, TItem>;
}

export function buildMetadataTools(client: TwentyClient) {
  return [
    // -----------------------------------------------------------------
    // OBJECTS — read
    // -----------------------------------------------------------------

    defineTwentyTool(
      {
        name: "twenty_metadata_objects_list",
        description:
          "List ALL metadata objects (standard + custom) in the Twenty workspace. " +
          "Returns the full set in a single call — the metadata API does NOT " +
          "support pagination or filtering query params. Use this to discover " +
          "objects by `nameSingular`, `isCustom`, `isActive`. For per-object " +
          "field listings, prefer `twenty_metadata_object_get` (it inlines " +
          "the fields[]).",
        parameters: Type.Object({}),
        run: async (_params, c, signal) => {
          const resp = await c.request<
            MetadataListResponse<TwentyMetadataObject>
          >("GET", METADATA_OBJECTS_PATH, { signal });
          const items = resp?.data?.objects ?? [];
          return {
            data: items,
            totalCount: items.length,
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_metadata_object_get",
        description:
          "Fetch a single metadata object by UUID. Includes the inline " +
          "`fields[]` array of every field declared on the object. Use this " +
          "to introspect a custom object before mutating its schema.",
        parameters: Type.Object({
          id: Type.String({ description: "Object metadata UUID" }),
        }),
        run: async (params, c, signal) => {
          const resp = await c.request<
            MetadataGetResponse<TwentyMetadataObject>
          >("GET", `${METADATA_OBJECTS_PATH}/${encodeURIComponent(params.id)}`, {
            signal,
          });
          return resp?.data?.object ?? null;
        },
      },
      client,
    ),

    // -----------------------------------------------------------------
    // OBJECTS — write (mutates → approval-gated by default)
    // -----------------------------------------------------------------

    defineTwentyTool(
      {
        name: "twenty_metadata_object_create",
        description:
          "Create a new custom object in the workspace (e.g. 'Mission', " +
          "'Diagnostic'). Provide `nameSingular`/`namePlural` (camelCase), " +
          "`labelSingular`/`labelPlural`, optional `icon` (Tabler) and " +
          "`description`. The new object is reachable via `/rest/<namePlural>` " +
          "immediately — schema regeneration is synchronous (verified ~60ms " +
          "round-trip on 2026-05-02). " +
          "This tool requires approval by default (see `approvalRequired`).",
        mutates: true,
        parameters: ObjectCreateSchema,
        run: async (params, c, signal) => {
          const resp = await c.request<
            MetadataWriteResponse<TwentyMetadataObject>
          >("POST", METADATA_OBJECTS_PATH, { body: params, signal });
          return resp?.data?.createOneObject ?? null;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_metadata_object_update",
        description:
          "Update an existing metadata object by UUID. Only supplied fields " +
          "are modified (PATCH semantics). Useful for renaming labels, " +
          "switching `icon`, toggling `isActive` to hide/show without " +
          "deletion, or pointing `labelIdentifierFieldMetadataId` to a " +
          "different field. `id` is required. " +
          "This tool requires approval by default (see `approvalRequired`).",
        mutates: true,
        parameters: ObjectUpdateSchema,
        run: async (params, c, signal) => {
          const { id, ...body } = params as { id: string } & Record<
            string,
            unknown
          >;
          if (typeof id !== "string" || id.length === 0) {
            throw new Error(
              "twenty_metadata_object_update: `id` is required and must be a non-empty UUID",
            );
          }
          const resp = await c.request<
            MetadataWriteResponse<TwentyMetadataObject>
          >(
            "PATCH",
            `${METADATA_OBJECTS_PATH}/${encodeURIComponent(id)}`,
            { body, signal },
          );
          return resp?.data?.updateOneObject ?? null;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_metadata_object_delete",
        description:
          "DESTRUCTIVE — IRREVERSIBLE. Hard-delete a custom metadata object " +
          "by UUID. Drops the object definition AND every record stored " +
          "under `/rest/<namePlural>`. The metadata API does not support " +
          "soft-delete on objects (passing `?soft_delete=true` produces a " +
          "400 because Twenty's UUID parser treats the query string as part " +
          "of the path). To soft-disable an object instead, use " +
          "`twenty_metadata_object_update` with `isActive: false`. " +
          "This tool requires approval by default (see `approvalRequired`).",
        mutates: true,
        parameters: Type.Object({
          id: Type.String({ description: "Object UUID to delete (HARD)" }),
        }),
        run: async (params, c, signal) => {
          const resp = await c.request<
            MetadataWriteResponse<{ id: string }>
          >(
            "DELETE",
            `${METADATA_OBJECTS_PATH}/${encodeURIComponent(params.id)}`,
            { signal },
          );
          return resp?.data?.deleteOneObject ?? { id: params.id };
        },
      },
      client,
    ),

    // -----------------------------------------------------------------
    // FIELDS — read
    // -----------------------------------------------------------------

    defineTwentyTool(
      {
        name: "twenty_metadata_fields_list",
        description:
          "List metadata fields. The metadata API does NOT support a " +
          "`?objectMetadataId=` query filter, and the field response does " +
          "not include the parent object id. " +
          "When `objectMetadataId` is supplied, the tool dispatches a " +
          "`GET /metadata/objects/{id}` and returns the inline `fields[]` " +
          "for that object only (preferred — much smaller response). " +
          "Without `objectMetadataId`, the tool returns ALL fields of every " +
          "object in the workspace (can be hundreds of entries on a mature " +
          "workspace).",
        parameters: Type.Object({
          objectMetadataId: Type.Optional(
            Type.String({
              description:
                "UUID of the parent object — when provided, only that object's fields are returned (via /metadata/objects/{id}).",
            }),
          ),
        }),
        run: async (params, c, signal) => {
          if (params.objectMetadataId) {
            // Smaller, structured: get the object and read its fields[].
            const resp = await c.request<
              MetadataGetResponse<TwentyMetadataObject>
            >(
              "GET",
              `${METADATA_OBJECTS_PATH}/${encodeURIComponent(
                params.objectMetadataId,
              )}`,
              { signal },
            );
            const fields = (resp?.data?.object?.fields ?? []) as
              TwentyMetadataField[];
            return {
              data: fields,
              totalCount: fields.length,
              source: "object",
            };
          }
          const resp = await c.request<
            MetadataListResponse<TwentyMetadataField>
          >("GET", METADATA_FIELDS_PATH, { signal });
          const items = resp?.data?.fields ?? [];
          return {
            data: items,
            totalCount: items.length,
            source: "fields",
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_metadata_field_get",
        description:
          "Fetch a single metadata field by UUID. Returns the full field " +
          "spec including `type`, `options` (for SELECT / MULTI_SELECT), " +
          "`settings`, and `relation` (for RELATION fields with " +
          "source/target object metadata).",
        parameters: Type.Object({
          id: Type.String({ description: "Field metadata UUID" }),
        }),
        run: async (params, c, signal) => {
          const resp = await c.request<
            MetadataGetResponse<TwentyMetadataField>
          >("GET", `${METADATA_FIELDS_PATH}/${encodeURIComponent(params.id)}`, {
            signal,
          });
          return resp?.data?.field ?? null;
        },
      },
      client,
    ),

    // -----------------------------------------------------------------
    // FIELDS — write (mutates → approval-gated by default)
    // -----------------------------------------------------------------

    defineTwentyTool(
      {
        name: "twenty_metadata_field_create",
        description:
          "Create a new custom field on a metadata object. Required: " +
          "`objectMetadataId` (parent UUID), `type` (e.g. 'TEXT', 'NUMBER', " +
          "'RELATION', ...), `name` (camelCase), `label`. Type-specific config " +
          "lives in `options` (SELECT/MULTI_SELECT enum entries), `settings` " +
          "(e.g. `{ relationType, onDelete }` for RELATION), and " +
          "`relationCreationPayload` (RELATION/MORPH_RELATION only — sets " +
          "the target object). Twenty validates the body and returns " +
          "actionable 400s; the message is forwarded verbatim to the agent. " +
          "This tool requires approval by default (see `approvalRequired`).",
        mutates: true,
        parameters: FieldCreateSchema,
        run: async (params, c, signal) => {
          const resp = await c.request<
            MetadataWriteResponse<TwentyMetadataField>
          >("POST", METADATA_FIELDS_PATH, { body: params, signal });
          return resp?.data?.createOneField ?? null;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_metadata_field_update",
        description:
          "Update an existing metadata field by UUID. Only supplied fields " +
          "are modified (PATCH semantics). Useful for renaming labels, " +
          "switching `icon`, toggling `isActive`, editing `options[]` for " +
          "SELECT/MULTI_SELECT, or tweaking `defaultValue`. `id` is required. " +
          "The field `type` is intentionally NOT exposed for update — to " +
          "change a field's type, delete and recreate it. " +
          "This tool requires approval by default (see `approvalRequired`).",
        mutates: true,
        parameters: FieldUpdateSchema,
        run: async (params, c, signal) => {
          const { id, ...body } = params as { id: string } & Record<
            string,
            unknown
          >;
          if (typeof id !== "string" || id.length === 0) {
            throw new Error(
              "twenty_metadata_field_update: `id` is required and must be a non-empty UUID",
            );
          }
          const resp = await c.request<
            MetadataWriteResponse<TwentyMetadataField>
          >(
            "PATCH",
            `${METADATA_FIELDS_PATH}/${encodeURIComponent(id)}`,
            { body, signal },
          );
          return resp?.data?.updateOneField ?? null;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_metadata_field_delete",
        description:
          "DESTRUCTIVE — IRREVERSIBLE. Hard-delete a custom field by UUID. " +
          "Drops the column from every record of the parent object. The " +
          "metadata API does not support soft-delete (the `?soft_delete=true` " +
          "query param triggers a 400 — Twenty parses it as part of the UUID). " +
          "To temporarily hide a field, use `twenty_metadata_field_update` " +
          "with `isActive: false`. " +
          "This tool requires approval by default (see `approvalRequired`).",
        mutates: true,
        parameters: Type.Object({
          id: Type.String({ description: "Field UUID to delete (HARD)" }),
        }),
        run: async (params, c, signal) => {
          const resp = await c.request<
            MetadataWriteResponse<{ id: string }>
          >(
            "DELETE",
            `${METADATA_FIELDS_PATH}/${encodeURIComponent(params.id)}`,
            { signal },
          );
          return resp?.data?.deleteOneField ?? { id: params.id };
        },
      },
      client,
    ),
  ];
}
