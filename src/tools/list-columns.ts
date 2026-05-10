// List columns — Surface 4 of the v0.8.0 plugin extension.
//
// Ergonomic wrappers on top of the Surface 1 ViewField primitives. The
// LLM uses these when the user phrases requests in column / list
// vocabulary ("show me the columns of the mission list", "move
// missionType to the first column", "hide the createdAt column").
// Internally everything resolves to:
//   - getViews(objectMetadataId, viewTypes:[TABLE]) when no viewId given
//   - getViewFields(viewId)
//   - updateViewField(input: { id, update: { ... } })
//
// "List columns" applies only to TABLE views. KANBAN cards and CALENDAR
// views are NOT covered (the LLM should pick the right Surface 1 tool
// for those). Record-detail layouts go through Surface 2 (PageLayout).

import { Type } from "@sinclair/typebox";

import { defineTwentyTool } from "./_factory.js";
import type { TwentyClient } from "../twenty-client.js";

interface ViewSummary {
  id: string;
  name: string;
  type: string;
  key: string | null;
  objectMetadataId: string;
}

interface ViewFieldRecord {
  id: string;
  fieldMetadataId: string;
  isVisible: boolean;
  position: number;
  size: number;
  aggregateOperation: string | null;
}

interface FieldMetadataLite {
  id: string;
  name: string;
  label: string;
  type: string;
  isCustom: boolean | null;
  isActive: boolean | null;
}

// ---------------------------------------------------------------------------
// Helpers shared across the tools.
// ---------------------------------------------------------------------------

/**
 * Resolve a viewId from either an explicit param or by looking up the
 * default INDEX TABLE view of an object. Throws if neither is supplied,
 * or if no INDEX view exists for the object.
 */
async function resolveTableViewId(
  client: TwentyClient,
  params: { viewId?: string; objectMetadataId?: string },
  signal?: AbortSignal,
): Promise<{ viewId: string; objectMetadataId: string }> {
  if (params.viewId) {
    // Resolve the objectMetadataId so callers always get both back.
    const data = await client.postGraphQL<{
      getView: ViewSummary | null;
    }>(
      `query LcView($id: String!) {
        getView(id: $id) { id name type key objectMetadataId }
      }`,
      { id: params.viewId },
      { signal },
    );
    if (!data?.getView) {
      throw new Error(`View ${params.viewId} not found`);
    }
    if (data.getView.type !== "TABLE") {
      throw new Error(
        `twenty_list_columns_*: viewId ${params.viewId} is type ` +
          `${data.getView.type}, expected TABLE. List-column tools only ` +
          `apply to TABLE views.`,
      );
    }
    return {
      viewId: data.getView.id,
      objectMetadataId: data.getView.objectMetadataId,
    };
  }

  if (!params.objectMetadataId) {
    throw new Error(
      "twenty_list_columns_*: provide either `viewId` or " +
        "`objectMetadataId` (to auto-resolve the default INDEX view).",
    );
  }

  const data = await client.postGraphQL<{ getViews: ViewSummary[] }>(
    `query LcViews($oid: String, $types: [ViewType!]) {
      getViews(objectMetadataId: $oid, viewTypes: $types) {
        id name type key objectMetadataId
      }
    }`,
    { oid: params.objectMetadataId, types: ["TABLE"] },
    { signal },
  );

  const tableViews = data?.getViews ?? [];
  // Twenty marks the default list view with key === "INDEX".
  const indexView = tableViews.find((v) => v.key === "INDEX") ?? tableViews[0];
  if (!indexView) {
    throw new Error(
      `twenty_list_columns_*: object ${params.objectMetadataId} has no ` +
        `TABLE view. Create one first via twenty_view_create.`,
    );
  }
  return { viewId: indexView.id, objectMetadataId: params.objectMetadataId };
}

/**
 * Fetch every ViewField of a view with the matching FieldMetadata
 * details joined (name / label / type) so the agent does not have to
 * call back to twenty_metadata_field_get for each one.
 */
async function fetchViewFieldsWithMeta(
  client: TwentyClient,
  viewId: string,
  objectMetadataId: string,
  signal?: AbortSignal,
): Promise<{
  viewFields: ViewFieldRecord[];
  fieldMetadata: Map<string, FieldMetadataLite>;
}> {
  const viewFieldsData = await client.postGraphQL<{
    getViewFields: ViewFieldRecord[];
  }>(
    `query LcViewFields($vid: String!) {
      getViewFields(viewId: $vid) {
        id fieldMetadataId isVisible position size aggregateOperation
      }
    }`,
    { vid: viewId },
    { signal },
  );
  const viewFields = viewFieldsData?.getViewFields ?? [];

  // One REST call to retrieve every field metadata of the parent object.
  // Cheaper than N round-trips and handles the case where a viewField
  // points at a since-deleted field gracefully (entry simply absent from
  // the map).
  const objectResp = await client.request<{
    data?: {
      object?: {
        fields?: { edges?: Array<{ node?: FieldMetadataLite }> };
      };
    };
  }>(
    "GET",
    `/rest/metadata/objects/${encodeURIComponent(objectMetadataId)}`,
    { signal },
  );
  const fieldMetadata = new Map<string, FieldMetadataLite>();
  const edges = objectResp?.data?.object?.fields?.edges ?? [];
  for (const edge of edges) {
    const node = edge?.node;
    if (node?.id) fieldMetadata.set(node.id, node);
  }
  return { viewFields, fieldMetadata };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const TargetSchema = Type.Object(
  {
    viewId: Type.Optional(
      Type.String({
        description:
          "Target view UUID. If omitted, the plugin auto-resolves the " +
          "default INDEX TABLE view of objectMetadataId.",
      }),
    ),
    objectMetadataId: Type.Optional(
      Type.String({
        description:
          "Parent object UUID. Used to auto-resolve the default INDEX " +
          "TABLE view when viewId is omitted.",
      }),
    ),
  },
  {
    description:
      "Provide either viewId (specific view) or objectMetadataId " +
      "(auto-resolve the default INDEX TABLE view). At least one is " +
      "required.",
  },
);

// NOTE — TypeBox `Type.Intersect` generates `allOf` at the top level of
// the JSON schema. OpenAI rejects function tools whose top-level schema
// uses `oneOf` / `anyOf` / `allOf` / `enum` / `not` (verified live on
// 2026-05-09 against the embedded codex provider with v0.8.0). We
// therefore inline TargetSchema's two optional fields (viewId,
// objectMetadataId) directly into each schema instead of intersecting.
const SetOrderSchema = Type.Object({
  viewId: Type.Optional(
    Type.String({
      description:
        "Target view UUID. If omitted, the plugin auto-resolves the " +
        "default INDEX TABLE view of objectMetadataId.",
    }),
  ),
  objectMetadataId: Type.Optional(
    Type.String({
      description:
        "Parent object UUID. Used to auto-resolve the default INDEX " +
        "TABLE view when viewId is omitted.",
    }),
  ),
  orderedFieldMetadataIds: Type.Array(Type.String(), {
    minItems: 1,
    description:
      "Field metadata UUIDs in the desired column order. Each entry " +
      "MUST already correspond to a ViewField on the view (call " +
      "twenty_list_columns_get first to discover them). The plugin " +
      "assigns positions 0, 1, 2, ... matching the array order. " +
      "ViewFields not listed keep their current position.",
  }),
});

const SetVisibilitySchema = Type.Object({
  viewId: Type.Optional(
    Type.String({
      description:
        "Target view UUID. If omitted, the plugin auto-resolves the " +
        "default INDEX TABLE view of objectMetadataId.",
    }),
  ),
  objectMetadataId: Type.Optional(
    Type.String({
      description:
        "Parent object UUID. Used to auto-resolve the default INDEX " +
        "TABLE view when viewId is omitted.",
    }),
  ),
  visibility: Type.Array(
    Type.Object({
      fieldMetadataId: Type.String(),
      isVisible: Type.Boolean(),
    }),
    {
      minItems: 1,
      description:
        "Bulk visibility toggle keyed by fieldMetadataId. Entries " +
        "without a matching ViewField on the view are skipped.",
    },
  ),
});

const SetSizeSchema = Type.Object({
  viewFieldId: Type.String({
    description:
      "ViewField UUID — the link between a view and a field. Get it " +
      "from twenty_list_columns_get (each entry exposes its viewFieldId).",
  }),
  size: Type.Number({
    minimum: 0,
    description:
      "Column width in pixels. 0 means 'use Twenty's default for this " +
      "field type'.",
  }),
});

const ResetDefaultsSchema = TargetSchema;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function buildListColumnsTools(client: TwentyClient) {
  return [
    defineTwentyTool(
      {
        name: "twenty_list_columns_get",
        description:
          "Return the ordered list of columns of a TABLE view, with each " +
          "column's name / label / type / visibility / position / size " +
          "and its viewFieldId (needed for set_size). When no viewId is " +
          "given, auto-resolves the default INDEX TABLE view of " +
          "objectMetadataId.",
        parameters: TargetSchema,
        run: async (params, c, signal) => {
          const { viewId, objectMetadataId } = await resolveTableViewId(
            c,
            params,
            signal,
          );
          const { viewFields, fieldMetadata } = await fetchViewFieldsWithMeta(
            c,
            viewId,
            objectMetadataId,
            signal,
          );

          const columns = viewFields
            .slice()
            .sort((a, b) => a.position - b.position)
            .map((vf) => {
              const meta = fieldMetadata.get(vf.fieldMetadataId);
              return {
                viewFieldId: vf.id,
                fieldMetadataId: vf.fieldMetadataId,
                name: meta?.name ?? null,
                label: meta?.label ?? null,
                type: meta?.type ?? null,
                isVisible: vf.isVisible,
                position: vf.position,
                size: vf.size,
                aggregateOperation: vf.aggregateOperation,
              };
            });

          return {
            viewId,
            objectMetadataId,
            count: columns.length,
            columns,
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_list_columns_set_order",
        description:
          "Reorder the columns of a TABLE view by supplying field " +
          "metadata UUIDs in the desired order. The plugin issues one " +
          "updateViewField mutation per matching ViewField with positions " +
          "0, 1, 2, .... Field UUIDs not present on the view are skipped. " +
          "Returns the updated count.",
        mutates: true,
        parameters: SetOrderSchema,
        run: async (params, c, signal) => {
          const { viewId, objectMetadataId } = await resolveTableViewId(
            c,
            params,
            signal,
          );
          const { viewFields } = await fetchViewFieldsWithMeta(
            c,
            viewId,
            objectMetadataId,
            signal,
          );
          const byFieldId = new Map<string, ViewFieldRecord>();
          for (const vf of viewFields) {
            byFieldId.set(vf.fieldMetadataId, vf);
          }

          const skipped: string[] = [];
          const updated: string[] = [];
          let position = 0;
          for (const fieldMetadataId of params.orderedFieldMetadataIds) {
            const vf = byFieldId.get(fieldMetadataId);
            if (!vf) {
              skipped.push(fieldMetadataId);
              continue;
            }
            await c.postGraphQL(
              `mutation LcReorder($input: UpdateViewFieldInput!) {
                updateViewField(input: $input) { id position }
              }`,
              {
                input: { id: vf.id, update: { position } },
              },
              { signal },
            );
            updated.push(vf.id);
            position++;
          }
          return {
            viewId,
            updatedCount: updated.length,
            skipped,
            order: updated,
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_list_columns_set_visibility",
        description:
          "Bulk-toggle column visibility on a TABLE view. Each entry " +
          "carries a fieldMetadataId + isVisible flag. Entries without a " +
          "matching ViewField on the view are skipped (and reported back " +
          "in the response).",
        mutates: true,
        parameters: SetVisibilitySchema,
        run: async (params, c, signal) => {
          const { viewId, objectMetadataId } = await resolveTableViewId(
            c,
            params,
            signal,
          );
          const { viewFields } = await fetchViewFieldsWithMeta(
            c,
            viewId,
            objectMetadataId,
            signal,
          );
          const byFieldId = new Map<string, ViewFieldRecord>();
          for (const vf of viewFields) {
            byFieldId.set(vf.fieldMetadataId, vf);
          }

          const skipped: string[] = [];
          const updated: string[] = [];
          for (const entry of params.visibility) {
            const vf = byFieldId.get(entry.fieldMetadataId);
            if (!vf) {
              skipped.push(entry.fieldMetadataId);
              continue;
            }
            await c.postGraphQL(
              `mutation LcVis($input: UpdateViewFieldInput!) {
                updateViewField(input: $input) { id isVisible }
              }`,
              {
                input: {
                  id: vf.id,
                  update: { isVisible: entry.isVisible },
                },
              },
              { signal },
            );
            updated.push(vf.id);
          }
          return { viewId, updatedCount: updated.length, skipped };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_list_column_set_size",
        description:
          "Set the pixel width of a single column. Prefer this over the " +
          "lower-level twenty_view_field_update when the agent only " +
          "needs to resize.",
        mutates: true,
        parameters: SetSizeSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            updateViewField: { id: string; size: number };
          }>(
            `mutation LcSize($input: UpdateViewFieldInput!) {
              updateViewField(input: $input) { id size }
            }`,
            {
              input: { id: params.viewFieldId, update: { size: params.size } },
            },
            { signal },
          );
          return data.updateViewField;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_list_columns_reset_default",
        description:
          "Reset the per-column display preferences (size + visibility " +
          "+ position) on a TABLE view. Twenty does not expose an atomic " +
          "'reset' mutation, so the plugin: (a) sets every ViewField to " +
          "isVisible=true and size=0, (b) renumbers positions in the " +
          "current declaration order. Field metadata is NOT touched and " +
          "no ViewField is destroyed. Approval-gated because it overwrites " +
          "every column on the view in one shot.",
        mutates: true,
        parameters: ResetDefaultsSchema,
        run: async (params, c, signal) => {
          const { viewId, objectMetadataId } = await resolveTableViewId(
            c,
            params,
            signal,
          );
          const { viewFields } = await fetchViewFieldsWithMeta(
            c,
            viewId,
            objectMetadataId,
            signal,
          );

          // Sort by current position so the renumbering is deterministic.
          const ordered = viewFields
            .slice()
            .sort((a, b) => a.position - b.position);

          let count = 0;
          for (let i = 0; i < ordered.length; i++) {
            const vf = ordered[i]!;
            await c.postGraphQL(
              `mutation LcReset($input: UpdateViewFieldInput!) {
                updateViewField(input: $input) {
                  id position size isVisible
                }
              }`,
              {
                input: {
                  id: vf.id,
                  update: { position: i, size: 0, isVisible: true },
                },
              },
              { signal },
            );
            count++;
          }
          return { viewId, resetCount: count };
        },
      },
      client,
    ),
  ];
}
