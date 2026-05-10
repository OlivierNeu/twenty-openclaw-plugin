// View-level tools — Surface 1 of the v0.8.0 plugin extension.
//
// Twenty's `View` is a saved configuration of how a user looks at the
// records of a single object: which fields are visible (ViewField),
// which records are filtered in (ViewFilter / ViewFilterGroup), which
// sort is applied (ViewSort), which kanban grouping is active
// (ViewGroup), and how fields are organised into visual blocks
// (ViewFieldGroup) on a record-detail-style view.
//
// Every entity is exposed via Twenty's `/metadata` GraphQL endpoint with
// a uniform CRUD vocabulary:
//   - `getXs(viewId)` / `getX(id)`        → reads
//   - `createX(input)`                    → write
//   - `updateX(input | id, input)`        → write
//   - `deleteX(input | id)`               → soft delete (reversible)
//   - `destroyX(input | id)`              → hard delete (irreversible)
//
// Soft delete sets `deletedAt`; the row remains queryable through
// Twenty's UI trash can and can be restored later. Hard destroy removes
// the row outright. The plugin exposes both with explicit naming
// (`*_delete` vs `*_destroy`) and approval-gates only the destroys.
//
// `getView(id)` joins every related collection (fields, filters,
// filter groups, sorts, groups, field groups) so a single tool call
// returns a complete picture of the view's state — convenient for the
// LLM to reason about before issuing follow-up mutations.

import { Type, type TSchema } from "@sinclair/typebox";

import { defineTwentyTool } from "./_factory.js";
import type { TwentyClient } from "../twenty-client.js";

// ---------------------------------------------------------------------------
// Enum schemas — narrow Twenty's GraphQL enums into TypeBox literals so the
// LLM cannot supply an invalid value (the model would otherwise have to
// memorise the spelling).
// ---------------------------------------------------------------------------

const ViewTypeSchema = Type.Union(
  [
    Type.Literal("TABLE"),
    Type.Literal("KANBAN"),
    Type.Literal("CALENDAR"),
    Type.Literal("FIELDS_WIDGET"),
    Type.Literal("TABLE_WIDGET"),
  ],
  {
    description:
      "View display type. TABLE = standard list, KANBAN = grouped " +
      "card columns, CALENDAR = date-positioned events, FIELDS_WIDGET / " +
      "TABLE_WIDGET = embedded view variants used inside dashboards. " +
      "Note: record-detail layouts are PageLayouts, not Views.",
  },
);

const ViewVisibilitySchema = Type.Union(
  [Type.Literal("WORKSPACE"), Type.Literal("UNLISTED")],
  {
    description:
      "WORKSPACE = visible to every workspace member; UNLISTED = " +
      "private to the creator (does not appear in the views list).",
  },
);

const ViewSortDirectionSchema = Type.Union(
  [Type.Literal("ASC"), Type.Literal("DESC")],
  { description: "Sort direction." },
);

const ViewOpenRecordInSchema = Type.Union(
  [Type.Literal("SIDE_PANEL"), Type.Literal("RECORD_PAGE")],
  {
    description:
      "How clicking a record from this view opens it. SIDE_PANEL = " +
      "drawer over the list; RECORD_PAGE = full record page navigation.",
  },
);

const ViewCalendarLayoutSchema = Type.Union(
  [
    Type.Literal("MONTH"),
    Type.Literal("WEEK"),
    Type.Literal("DAY"),
    Type.Literal("YEAR"),
  ],
  {
    description:
      "Calendar layout granularity (only meaningful when type=CALENDAR).",
  },
);

const ViewFilterOperandSchema = Type.Union(
  [
    Type.Literal("IS"),
    Type.Literal("IS_NOT_NULL"),
    Type.Literal("IS_NOT"),
    Type.Literal("LESS_THAN_OR_EQUAL"),
    Type.Literal("GREATER_THAN_OR_EQUAL"),
    Type.Literal("IS_BEFORE"),
    Type.Literal("IS_AFTER"),
    Type.Literal("CONTAINS"),
    Type.Literal("DOES_NOT_CONTAIN"),
    Type.Literal("IS_EMPTY"),
    Type.Literal("IS_NOT_EMPTY"),
    Type.Literal("IS_RELATIVE"),
    Type.Literal("IS_IN_PAST"),
    Type.Literal("IS_IN_FUTURE"),
    Type.Literal("IS_TODAY"),
    Type.Literal("VECTOR_SEARCH"),
  ],
  {
    description:
      "ViewFilter operand. The Twenty UI surfaces a different subset " +
      "depending on the field type (e.g. IS_BEFORE is only relevant for " +
      "DATE / DATE_TIME). The plugin does not validate the combo — " +
      "Twenty rejects invalid pairs server-side with a GraphQL error.",
  },
);

const ViewFilterGroupLogicalOperatorSchema = Type.Union(
  [Type.Literal("AND"), Type.Literal("OR")],
  { description: "How sibling filters in a group combine." },
);

const AggregateOperationSchema = Type.Union(
  [
    Type.Literal("COUNT"),
    Type.Literal("COUNT_EMPTY"),
    Type.Literal("COUNT_NOT_EMPTY"),
    Type.Literal("COUNT_UNIQUE_VALUES"),
    Type.Literal("PERCENTAGE_EMPTY"),
    Type.Literal("PERCENTAGE_NOT_EMPTY"),
    Type.Literal("AVG"),
    Type.Literal("MIN"),
    Type.Literal("MAX"),
    Type.Literal("SUM"),
  ],
  {
    description:
      "Aggregation applied on a field (used by KANBAN total banner and " +
      "by ViewField summary footer). COUNT* and PERCENTAGE* work on any " +
      "field type; AVG/MIN/MAX/SUM require numeric/date.",
  },
);

// ---------------------------------------------------------------------------
// Common parameter shapes.
// ---------------------------------------------------------------------------

const ViewIdParam = Type.Object({
  viewId: Type.String({ description: "View UUID" }),
});

// ---------------------------------------------------------------------------
// Response shapes (selection sets we use repeatedly).
// ---------------------------------------------------------------------------

const VIEW_FRAGMENT = `
  id name objectMetadataId type key icon position isCompact isCustom
  openRecordIn kanbanAggregateOperation kanbanAggregateOperationFieldMetadataId
  mainGroupByFieldMetadataId shouldHideEmptyGroups calendarFieldMetadataId
  calendarLayout anyFieldFilterValue visibility createdAt updatedAt deletedAt
`;

const VIEW_FIELD_FRAGMENT = `
  id viewId fieldMetadataId viewFieldGroupId isVisible position size
  aggregateOperation isActive createdAt updatedAt deletedAt
`;

const VIEW_FIELD_GROUP_FRAGMENT = `
  id viewId name position isVisible isActive createdAt updatedAt deletedAt
`;

const VIEW_FILTER_FRAGMENT = `
  id viewId fieldMetadataId operand value viewFilterGroupId
  positionInViewFilterGroup subFieldName createdAt updatedAt deletedAt
`;

const VIEW_FILTER_GROUP_FRAGMENT = `
  id viewId logicalOperator parentViewFilterGroupId positionInViewFilterGroup
  createdAt updatedAt deletedAt
`;

const VIEW_SORT_FRAGMENT = `
  id viewId fieldMetadataId direction createdAt updatedAt deletedAt
`;

const VIEW_GROUP_FRAGMENT = `
  id viewId fieldValue position isVisible createdAt updatedAt deletedAt
`;

interface ViewResponse {
  id: string;
  name: string;
  objectMetadataId: string;
  type: string;
  [key: string]: unknown;
}

interface ViewFieldResponse {
  id: string;
  viewId: string;
  fieldMetadataId: string;
  isVisible: boolean;
  position: number;
  size: number;
  aggregateOperation: string | null;
  [key: string]: unknown;
}

interface ViewFieldGroupResponse {
  id: string;
  viewId: string;
  name: string;
  position: number;
  isVisible: boolean;
  [key: string]: unknown;
}

interface ViewFilterResponse {
  id: string;
  viewId: string;
  fieldMetadataId: string;
  operand: string;
  [key: string]: unknown;
}

interface ViewFilterGroupResponse {
  id: string;
  viewId: string;
  [key: string]: unknown;
}

interface ViewSortResponse {
  id: string;
  viewId: string;
  fieldMetadataId: string;
  direction: string;
  [key: string]: unknown;
}

interface ViewGroupResponse {
  id: string;
  viewId: string;
  fieldValue: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Per-tool schemas. Grouped by entity for navigation.
// ---------------------------------------------------------------------------

// --- View top-level ---

const ListViewsSchema = Type.Object({
  objectMetadataId: Type.Optional(
    Type.String({
      description:
        "Filter by parent object UUID. Omit to list every view in the " +
        "workspace (across all objects).",
    }),
  ),
  viewTypes: Type.Optional(
    Type.Array(ViewTypeSchema, {
      description:
        "Filter by view type. Omit to include every type. Useful to scope " +
        "to TABLE views (the typical list) or KANBAN (the typical board).",
    }),
  ),
});

const GetViewSchema = ViewIdParam;

const CreateViewSchema = Type.Object({
  objectMetadataId: Type.String({
    description: "UUID of the object the view targets.",
  }),
  name: Type.String({ description: "View name shown in the picker." }),
  type: ViewTypeSchema,
  icon: Type.String({
    description:
      "Tabler icon name (e.g. 'IconList', 'IconTable', 'IconLayoutKanban'). " +
      "REQUIRED by Twenty 2.1's CreateViewInput.",
  }),
  position: Type.Optional(
    Type.Number({
      description:
        "Float ordering within the views menu. Smaller = earlier. Twenty " +
        "auto-positions when omitted.",
    }),
  ),
  isCompact: Type.Optional(Type.Boolean()),
  isCustom: Type.Optional(Type.Boolean()),
  openRecordIn: Type.Optional(ViewOpenRecordInSchema),
  kanbanAggregateOperation: Type.Optional(AggregateOperationSchema),
  kanbanAggregateOperationFieldMetadataId: Type.Optional(Type.String()),
  mainGroupByFieldMetadataId: Type.Optional(
    Type.String({
      description:
        "Required when type=KANBAN: the field whose values become the " +
        "kanban columns.",
    }),
  ),
  shouldHideEmptyGroups: Type.Optional(Type.Boolean()),
  calendarFieldMetadataId: Type.Optional(
    Type.String({
      description:
        "Required when type=CALENDAR: the date field positioning events.",
    }),
  ),
  calendarLayout: Type.Optional(ViewCalendarLayoutSchema),
  visibility: Type.Optional(ViewVisibilitySchema),
});

const UpdateViewSchema = Type.Object({
  viewId: Type.String({ description: "View UUID to update." }),
  name: Type.Optional(Type.String()),
  icon: Type.Optional(Type.String()),
  position: Type.Optional(Type.Number()),
  isCompact: Type.Optional(Type.Boolean()),
  openRecordIn: Type.Optional(ViewOpenRecordInSchema),
  kanbanAggregateOperation: Type.Optional(AggregateOperationSchema),
  kanbanAggregateOperationFieldMetadataId: Type.Optional(Type.String()),
  mainGroupByFieldMetadataId: Type.Optional(Type.String()),
  shouldHideEmptyGroups: Type.Optional(Type.Boolean()),
  calendarFieldMetadataId: Type.Optional(Type.String()),
  calendarLayout: Type.Optional(ViewCalendarLayoutSchema),
  visibility: Type.Optional(ViewVisibilitySchema),
});

const DeleteViewSchema = ViewIdParam;
const DestroyViewSchema = ViewIdParam;

const DuplicateViewSchema = Type.Object({
  sourceViewId: Type.String({ description: "View UUID to duplicate." }),
  newName: Type.String({ description: "Name for the duplicated view." }),
  copyFields: Type.Optional(
    Type.Boolean({
      default: true,
      description: "Copy ViewFields into the new view (defaults true).",
    }),
  ),
  copyFilters: Type.Optional(
    Type.Boolean({
      default: true,
      description: "Copy ViewFilters into the new view (defaults true).",
    }),
  ),
  copySorts: Type.Optional(
    Type.Boolean({
      default: true,
      description: "Copy ViewSorts into the new view (defaults true).",
    }),
  ),
  copyGroups: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "Copy ViewGroups (kanban columns) — defaults false because the " +
        "groups are usually rebuilt for the new use-case.",
    }),
  ),
});

// --- ViewField ---

const AddViewFieldSchema = Type.Object({
  viewId: Type.String(),
  fieldMetadataId: Type.String(),
  isVisible: Type.Optional(Type.Boolean({ default: true })),
  position: Type.Optional(Type.Number()),
  size: Type.Optional(
    Type.Number({
      description:
        "Column width in pixels (TABLE) or unitless score (other types).",
    }),
  ),
  aggregateOperation: Type.Optional(AggregateOperationSchema),
  viewFieldGroupId: Type.Optional(
    Type.String({
      description:
        "Parent ViewFieldGroup UUID (when the field belongs to a visual " +
        "block on a record detail view). Omit for ungrouped fields.",
    }),
  ),
});

const UpdateViewFieldSchema = Type.Object({
  viewFieldId: Type.String({ description: "ViewField UUID." }),
  isVisible: Type.Optional(Type.Boolean()),
  position: Type.Optional(Type.Number()),
  size: Type.Optional(Type.Number()),
  aggregateOperation: Type.Optional(AggregateOperationSchema),
  viewFieldGroupId: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description: "Pass null to detach the field from any group.",
    }),
  ),
});

const DeleteViewFieldSchema = Type.Object({
  viewFieldId: Type.String(),
});
const DestroyViewFieldSchema = Type.Object({
  viewFieldId: Type.String(),
});

const ReorderViewFieldsSchema = Type.Object({
  viewId: Type.String(),
  orderedViewFieldIds: Type.Array(Type.String(), {
    minItems: 1,
    description:
      "ViewField UUIDs in the desired order. The plugin assigns " +
      "incrementing positions (0, 1, 2, ...) and updates each in turn. " +
      "Any ViewFields not in the list keep their current positions.",
  }),
});

// --- ViewFieldGroup ---

const AddViewFieldGroupSchema = Type.Object({
  viewId: Type.String(),
  name: Type.String({
    description:
      "Group label (visible block heading on record detail views).",
  }),
  position: Type.Optional(Type.Number()),
  isVisible: Type.Optional(Type.Boolean({ default: true })),
});

const UpdateViewFieldGroupSchema = Type.Object({
  viewFieldGroupId: Type.String(),
  name: Type.Optional(Type.String()),
  position: Type.Optional(Type.Number()),
  isVisible: Type.Optional(Type.Boolean()),
});

const DeleteViewFieldGroupSchema = Type.Object({
  viewFieldGroupId: Type.String(),
});
const DestroyViewFieldGroupSchema = Type.Object({
  viewFieldGroupId: Type.String(),
});

// --- ViewFilter ---

const AddViewFilterSchema = Type.Object({
  viewId: Type.String(),
  fieldMetadataId: Type.String(),
  operand: ViewFilterOperandSchema,
  value: Type.Any({
    description:
      "Filter value. JSON-encoded by Twenty: scalar (string/number/" +
      "boolean), array (e.g. for IS / IS_NOT against multi-select), or " +
      "object for relative-date pickers. Type depends on the field+operand.",
  }),
  viewFilterGroupId: Type.Optional(
    Type.String({
      description:
        "Parent ViewFilterGroup UUID. Omit for top-level filters.",
    }),
  ),
  positionInViewFilterGroup: Type.Optional(Type.Number()),
  subFieldName: Type.Optional(
    Type.String({
      description:
        "Sub-field path for composite types (e.g. 'firstName' on a " +
        "FULL_NAME field). Required when filtering on a sub-component.",
    }),
  ),
});

const UpdateViewFilterSchema = Type.Object({
  viewFilterId: Type.String(),
  operand: Type.Optional(ViewFilterOperandSchema),
  value: Type.Optional(Type.Any()),
  viewFilterGroupId: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description: "Pass null to detach the filter from any group.",
    }),
  ),
  positionInViewFilterGroup: Type.Optional(Type.Number()),
  subFieldName: Type.Optional(Type.String()),
});

const DeleteViewFilterSchema = Type.Object({
  viewFilterId: Type.String(),
});
const DestroyViewFilterSchema = Type.Object({
  viewFilterId: Type.String(),
});

// --- ViewFilterGroup ---

const AddViewFilterGroupSchema = Type.Object({
  viewId: Type.String(),
  logicalOperator: Type.Optional(ViewFilterGroupLogicalOperatorSchema),
  parentViewFilterGroupId: Type.Optional(
    Type.String({
      description:
        "Parent group UUID for nested logical groups (AND-of-OR-of-AND).",
    }),
  ),
  positionInViewFilterGroup: Type.Optional(Type.Number()),
});

const UpdateViewFilterGroupSchema = Type.Object({
  viewFilterGroupId: Type.String(),
  logicalOperator: Type.Optional(ViewFilterGroupLogicalOperatorSchema),
  parentViewFilterGroupId: Type.Optional(
    Type.Union([Type.String(), Type.Null()]),
  ),
  positionInViewFilterGroup: Type.Optional(Type.Number()),
});

const DeleteViewFilterGroupSchema = Type.Object({
  viewFilterGroupId: Type.String(),
});
const DestroyViewFilterGroupSchema = Type.Object({
  viewFilterGroupId: Type.String(),
});

// --- ViewSort ---

const AddViewSortSchema = Type.Object({
  viewId: Type.String(),
  fieldMetadataId: Type.String(),
  direction: ViewSortDirectionSchema,
});

const UpdateViewSortSchema = Type.Object({
  viewSortId: Type.String(),
  direction: Type.Optional(ViewSortDirectionSchema),
});

const DeleteViewSortSchema = Type.Object({
  viewSortId: Type.String(),
});
const DestroyViewSortSchema = Type.Object({
  viewSortId: Type.String(),
});

// --- ViewGroup (kanban columns) ---

const AddViewGroupSchema = Type.Object({
  viewId: Type.String(),
  fieldValue: Type.String({
    description:
      "Grouping key — must match a value of the kanban field referenced " +
      "by view.mainGroupByFieldMetadataId.",
  }),
  position: Type.Optional(Type.Number()),
  isVisible: Type.Optional(Type.Boolean({ default: true })),
});

const UpdateViewGroupSchema = Type.Object({
  viewGroupId: Type.String(),
  position: Type.Optional(Type.Number()),
  isVisible: Type.Optional(Type.Boolean()),
});

const DeleteViewGroupSchema = Type.Object({
  viewGroupId: Type.String(),
});
const DestroyViewGroupSchema = Type.Object({
  viewGroupId: Type.String(),
});

// ---------------------------------------------------------------------------
// Tool builder.
// ---------------------------------------------------------------------------

export function buildViewsTools(client: TwentyClient) {
  return [
    // -------- View top-level (7 tools) --------

    defineTwentyTool(
      {
        name: "twenty_views_list",
        description:
          "List Twenty views, optionally filtered by parent objectMetadataId " +
          "and/or by viewTypes (TABLE/KANBAN/CALENDAR/FIELDS_WIDGET/" +
          "TABLE_WIDGET). Returns the view summary fields (no joined " +
          "fields/filters/sorts — call twenty_view_get for those).",
        parameters: ListViewsSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{ getViews: ViewResponse[] }>(
            `query ViewsList($objectMetadataId: String, $viewTypes: [ViewType!]) {
              getViews(objectMetadataId: $objectMetadataId, viewTypes: $viewTypes) {
                ${VIEW_FRAGMENT}
              }
            }`,
            {
              objectMetadataId: params.objectMetadataId ?? null,
              viewTypes: params.viewTypes ?? null,
            },
            { signal },
          );
          const views = data?.getViews ?? [];
          return { count: views.length, views };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_view_get",
        description:
          "Fetch a single view with every related collection joined: " +
          "viewFields, viewFieldGroups, viewFilters, viewFilterGroups, " +
          "viewSorts, viewGroups. One round trip — convenient before " +
          "issuing follow-up mutations.",
        parameters: GetViewSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            getView: ViewResponse | null;
            getViewFields: ViewFieldResponse[];
            getViewFieldGroups: ViewFieldGroupResponse[];
            getViewFilters: ViewFilterResponse[];
            getViewFilterGroups: ViewFilterGroupResponse[];
            getViewSorts: ViewSortResponse[];
            getViewGroups: ViewGroupResponse[];
          }>(
            `query ViewWithRelations($id: String!, $viewId: String!) {
              getView(id: $id) { ${VIEW_FRAGMENT} }
              getViewFields(viewId: $viewId) { ${VIEW_FIELD_FRAGMENT} }
              getViewFieldGroups(viewId: $viewId) { ${VIEW_FIELD_GROUP_FRAGMENT} }
              getViewFilters(viewId: $viewId) { ${VIEW_FILTER_FRAGMENT} }
              getViewFilterGroups(viewId: $viewId) { ${VIEW_FILTER_GROUP_FRAGMENT} }
              getViewSorts(viewId: $viewId) { ${VIEW_SORT_FRAGMENT} }
              getViewGroups(viewId: $viewId) { ${VIEW_GROUP_FRAGMENT} }
            }`,
            { id: params.viewId, viewId: params.viewId },
            { signal },
          );
          if (!data?.getView) {
            throw new Error(`View ${params.viewId} not found`);
          }
          return {
            view: data.getView,
            viewFields: data.getViewFields ?? [],
            viewFieldGroups: data.getViewFieldGroups ?? [],
            viewFilters: data.getViewFilters ?? [],
            viewFilterGroups: data.getViewFilterGroups ?? [],
            viewSorts: data.getViewSorts ?? [],
            viewGroups: data.getViewGroups ?? [],
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_view_create",
        description:
          "Create a new view on the given object. Required: objectMetadataId, " +
          "name, type. KANBAN requires mainGroupByFieldMetadataId; CALENDAR " +
          "requires calendarFieldMetadataId. Returns the created view UUID " +
          "and base fields. Add fields/filters/sorts via the dedicated " +
          "twenty_view_field_add / _filter_add / _sort_add tools.",
        mutates: true,
        parameters: CreateViewSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{ createView: ViewResponse }>(
            `mutation CreateView($input: CreateViewInput!) {
              createView(input: $input) { ${VIEW_FRAGMENT} }
            }`,
            { input: params },
            { signal },
          );
          return data.createView;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_view_update",
        description:
          "Patch view properties (name, icon, position, kanban/calendar " +
          "config, visibility, ...). All fields except viewId are optional " +
          "— pass only what changes. Returns the updated view.",
        mutates: true,
        parameters: UpdateViewSchema,
        run: async (params, c, signal) => {
          const { viewId, ...input } = params;
          const data = await c.postGraphQL<{ updateView: ViewResponse }>(
            `mutation UpdateView($id: String!, $input: UpdateViewInput!) {
              updateView(id: $id, input: $input) { ${VIEW_FRAGMENT} }
            }`,
            { id: viewId, input },
            { signal },
          );
          return data.updateView;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_view_delete",
        description:
          "Soft-delete a view (sets deletedAt). The view disappears from " +
          "the picker but rows remain in the database — restorable through " +
          "Twenty's UI. Use twenty_view_destroy for irreversible removal.",
        mutates: true,
        parameters: DeleteViewSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{ deleteView: boolean }>(
            `mutation DeleteView($id: String!) { deleteView(id: $id) }`,
            { id: params.viewId },
            { signal },
          );
          return { viewId: params.viewId, deleted: data.deleteView === true };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_view_destroy",
        description:
          "HARD-delete a view and every dependent ViewField, ViewFilter, " +
          "ViewSort, ViewGroup, ViewFieldGroup. Irreversible. Approval-" +
          "gated by default. Prefer twenty_view_delete for reversible " +
          "removal.",
        mutates: true,
        parameters: DestroyViewSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{ destroyView: boolean }>(
            `mutation DestroyView($id: String!) { destroyView(id: $id) }`,
            { id: params.viewId },
            { signal },
          );
          return { viewId: params.viewId, destroyed: data.destroyView === true };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_view_duplicate",
        description:
          "Duplicate a view: creates a new View row pointing at the same " +
          "object, then optionally copies its ViewFields / ViewFilters / " +
          "ViewSorts / ViewGroups. Useful to fork a working layout for " +
          "experimentation. Returns the new view + counts of copied " +
          "children.",
        mutates: true,
        parameters: DuplicateViewSchema,
        run: async (params, c, signal) => {
          // Step 1 — fetch source view + its children.
          const src = await c.postGraphQL<{
            getView: ViewResponse | null;
            getViewFields: ViewFieldResponse[];
            getViewFilters: ViewFilterResponse[];
            getViewSorts: ViewSortResponse[];
            getViewGroups: ViewGroupResponse[];
          }>(
            `query SourceView($id: String!, $viewId: String!) {
              getView(id: $id) { ${VIEW_FRAGMENT} }
              getViewFields(viewId: $viewId) { ${VIEW_FIELD_FRAGMENT} }
              getViewFilters(viewId: $viewId) { ${VIEW_FILTER_FRAGMENT} }
              getViewSorts(viewId: $viewId) { ${VIEW_SORT_FRAGMENT} }
              getViewGroups(viewId: $viewId) { ${VIEW_GROUP_FRAGMENT} }
            }`,
            { id: params.sourceViewId, viewId: params.sourceViewId },
            { signal },
          );
          const source = src?.getView;
          if (!source) {
            throw new Error(`Source view ${params.sourceViewId} not found`);
          }

          // Step 2 — create the destination view.
          type CreateResp = { createView: ViewResponse };
          const created = await c.postGraphQL<CreateResp>(
            `mutation DupCreate($input: CreateViewInput!) {
              createView(input: $input) { ${VIEW_FRAGMENT} }
            }`,
            {
              input: {
                objectMetadataId: source.objectMetadataId,
                name: params.newName,
                type: source.type,
                icon: (source.icon as string | null) ?? null,
                isCompact: source.isCompact ?? null,
                openRecordIn: source.openRecordIn ?? null,
                kanbanAggregateOperation:
                  source.kanbanAggregateOperation ?? null,
                kanbanAggregateOperationFieldMetadataId:
                  source.kanbanAggregateOperationFieldMetadataId ?? null,
                mainGroupByFieldMetadataId:
                  source.mainGroupByFieldMetadataId ?? null,
                shouldHideEmptyGroups: source.shouldHideEmptyGroups ?? null,
                calendarFieldMetadataId:
                  source.calendarFieldMetadataId ?? null,
                calendarLayout: source.calendarLayout ?? null,
                visibility: source.visibility ?? "WORKSPACE",
              },
            },
            { signal },
          );
          const newViewId = created.createView.id;

          // Step 3 — replicate children.
          let copiedFields = 0;
          if (params.copyFields !== false) {
            for (const f of src.getViewFields ?? []) {
              await c.postGraphQL(
                `mutation DupField($input: CreateViewFieldInput!) {
                  createViewField(input: $input) { id }
                }`,
                {
                  input: {
                    viewId: newViewId,
                    fieldMetadataId: f.fieldMetadataId,
                    isVisible: f.isVisible,
                    position: f.position,
                    size: f.size,
                    aggregateOperation: f.aggregateOperation ?? null,
                  },
                },
                { signal },
              );
              copiedFields++;
            }
          }

          let copiedFilters = 0;
          if (params.copyFilters !== false) {
            for (const f of src.getViewFilters ?? []) {
              await c.postGraphQL(
                `mutation DupFilter($input: CreateViewFilterInput!) {
                  createViewFilter(input: $input) { id }
                }`,
                {
                  input: {
                    viewId: newViewId,
                    fieldMetadataId: f.fieldMetadataId,
                    operand: f.operand,
                    value: (f as ViewFilterResponse & { value?: unknown }).value,
                    subFieldName:
                      (f as ViewFilterResponse & { subFieldName?: string | null })
                        .subFieldName ?? null,
                  },
                },
                { signal },
              );
              copiedFilters++;
            }
          }

          let copiedSorts = 0;
          if (params.copySorts !== false) {
            for (const s of src.getViewSorts ?? []) {
              await c.postGraphQL(
                `mutation DupSort($input: CreateViewSortInput!) {
                  createViewSort(input: $input) { id }
                }`,
                {
                  input: {
                    viewId: newViewId,
                    fieldMetadataId: s.fieldMetadataId,
                    direction: s.direction,
                  },
                },
                { signal },
              );
              copiedSorts++;
            }
          }

          let copiedGroups = 0;
          if (params.copyGroups === true) {
            for (const g of src.getViewGroups ?? []) {
              await c.postGraphQL(
                `mutation DupGroup($input: CreateViewGroupInput!) {
                  createViewGroup(input: $input) { id }
                }`,
                {
                  input: {
                    viewId: newViewId,
                    fieldValue: g.fieldValue,
                    position: g.position,
                    isVisible:
                      (g as ViewGroupResponse & { isVisible?: boolean })
                        .isVisible ?? true,
                  },
                },
                { signal },
              );
              copiedGroups++;
            }
          }

          return {
            view: created.createView,
            copiedFields,
            copiedFilters,
            copiedSorts,
            copiedGroups,
          };
        },
      },
      client,
    ),

    // -------- ViewField (5 tools) --------

    defineTwentyTool(
      {
        name: "twenty_view_field_add",
        description:
          "Add a field to a view. Required: viewId + fieldMetadataId. " +
          "Optional: isVisible (default true), position, size, " +
          "aggregateOperation (footer summary), viewFieldGroupId (visual " +
          "block parent on record detail views).",
        mutates: true,
        parameters: AddViewFieldSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            createViewField: ViewFieldResponse;
          }>(
            `mutation AddViewField($input: CreateViewFieldInput!) {
              createViewField(input: $input) { ${VIEW_FIELD_FRAGMENT} }
            }`,
            { input: params },
            { signal },
          );
          return data.createViewField;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_view_field_update",
        description:
          "Patch a ViewField (visibility, position, size, aggregate, group " +
          "membership). Pass viewFieldGroupId=null to detach the field " +
          "from any group.",
        mutates: true,
        parameters: UpdateViewFieldSchema,
        run: async (params, c, signal) => {
          const { viewFieldId, ...updates } = params;
          const data = await c.postGraphQL<{
            updateViewField: ViewFieldResponse;
          }>(
            `mutation UpdateViewField($input: UpdateViewFieldInput!) {
              updateViewField(input: $input) { ${VIEW_FIELD_FRAGMENT} }
            }`,
            { input: { id: viewFieldId, update: updates } },
            { signal },
          );
          return data.updateViewField;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_view_field_delete",
        description:
          "Soft-delete a ViewField (the field disappears from the view but " +
          "remains restorable). Does NOT delete the underlying field " +
          "metadata — that is twenty_metadata_field_delete.",
        mutates: true,
        parameters: DeleteViewFieldSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            deleteViewField: ViewFieldResponse;
          }>(
            `mutation DeleteViewField($input: DeleteViewFieldInput!) {
              deleteViewField(input: $input) { ${VIEW_FIELD_FRAGMENT} }
            }`,
            { input: { id: params.viewFieldId } },
            { signal },
          );
          return data.deleteViewField;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_view_field_destroy",
        description:
          "HARD-delete a ViewField. Irreversible. Approval-gated. " +
          "Prefer twenty_view_field_delete for reversible removal.",
        mutates: true,
        parameters: DestroyViewFieldSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            destroyViewField: ViewFieldResponse;
          }>(
            `mutation DestroyViewField($input: DestroyViewFieldInput!) {
              destroyViewField(input: $input) { ${VIEW_FIELD_FRAGMENT} }
            }`,
            { input: { id: params.viewFieldId } },
            { signal },
          );
          return data.destroyViewField;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_view_fields_reorder",
        description:
          "Reorder the fields of a view by supplying their ViewField UUIDs " +
          "in the desired order. The plugin assigns positions 0, 1, 2, ... " +
          "to each entry. Any ViewFields not in the list keep their current " +
          "position. Use this when the model wants to do 'move field X to " +
          "first column'.",
        mutates: true,
        parameters: ReorderViewFieldsSchema,
        run: async (params, c, signal) => {
          const updated: string[] = [];
          for (let i = 0; i < params.orderedViewFieldIds.length; i++) {
            const id = params.orderedViewFieldIds[i]!;
            await c.postGraphQL(
              `mutation ReorderField($input: UpdateViewFieldInput!) {
                updateViewField(input: $input) { id position }
              }`,
              { input: { id, update: { position: i } } },
              { signal },
            );
            updated.push(id);
          }
          return { viewId: params.viewId, updatedCount: updated.length, order: updated };
        },
      },
      client,
    ),

    // -------- ViewFieldGroup (3 tools) --------

    defineTwentyTool(
      {
        name: "twenty_view_field_group_add",
        description:
          "Create a visual field group (block heading) on a view. Used to " +
          "organise fields into named sections on record detail views. " +
          "Returns the new ViewFieldGroup UUID — pass it as " +
          "viewFieldGroupId on twenty_view_field_add to assign fields.",
        mutates: true,
        parameters: AddViewFieldGroupSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            createViewFieldGroup: ViewFieldGroupResponse;
          }>(
            `mutation AddFieldGroup($input: CreateViewFieldGroupInput!) {
              createViewFieldGroup(input: $input) { ${VIEW_FIELD_GROUP_FRAGMENT} }
            }`,
            { input: params },
            { signal },
          );
          return data.createViewFieldGroup;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_view_field_group_update",
        description:
          "Patch a ViewFieldGroup (rename, reposition, hide).",
        mutates: true,
        parameters: UpdateViewFieldGroupSchema,
        run: async (params, c, signal) => {
          const { viewFieldGroupId, ...updates } = params;
          const data = await c.postGraphQL<{
            updateViewFieldGroup: ViewFieldGroupResponse;
          }>(
            `mutation UpdateFieldGroup($input: UpdateViewFieldGroupInput!) {
              updateViewFieldGroup(input: $input) { ${VIEW_FIELD_GROUP_FRAGMENT} }
            }`,
            {
              input: { id: viewFieldGroupId, update: updates },
            },
            { signal },
          );
          return data.updateViewFieldGroup;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_view_field_group_delete",
        description:
          "Soft-delete a ViewFieldGroup. Fields previously assigned to the " +
          "group remain on the view but become ungrouped (their " +
          "viewFieldGroupId is left dangling — issue twenty_view_field_update " +
          "with viewFieldGroupId=null to clean them up if needed).",
        mutates: true,
        parameters: DeleteViewFieldGroupSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            deleteViewFieldGroup: ViewFieldGroupResponse;
          }>(
            `mutation DeleteFieldGroup($input: DeleteViewFieldGroupInput!) {
              deleteViewFieldGroup(input: $input) { ${VIEW_FIELD_GROUP_FRAGMENT} }
            }`,
            { input: { id: params.viewFieldGroupId } },
            { signal },
          );
          return data.deleteViewFieldGroup;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_view_field_group_destroy",
        description:
          "HARD-delete a ViewFieldGroup. Irreversible. Approval-gated. " +
          "Prefer twenty_view_field_group_delete for reversible removal.",
        mutates: true,
        parameters: DestroyViewFieldGroupSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            destroyViewFieldGroup: ViewFieldGroupResponse;
          }>(
            `mutation DestroyFieldGroup($input: DestroyViewFieldGroupInput!) {
              destroyViewFieldGroup(input: $input) { ${VIEW_FIELD_GROUP_FRAGMENT} }
            }`,
            { input: { id: params.viewFieldGroupId } },
            { signal },
          );
          return data.destroyViewFieldGroup;
        },
      },
      client,
    ),

    // -------- ViewFilter (3 tools) --------

    defineTwentyTool(
      {
        name: "twenty_view_filter_add",
        description:
          "Add a filter to a view. Required: viewId + fieldMetadataId + " +
          "operand. Value type depends on operand+field — see " +
          "ViewFilterOperand description. Optional viewFilterGroupId puts " +
          "the filter inside a logical AND/OR group.",
        mutates: true,
        parameters: AddViewFilterSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            createViewFilter: ViewFilterResponse;
          }>(
            `mutation AddViewFilter($input: CreateViewFilterInput!) {
              createViewFilter(input: $input) { ${VIEW_FILTER_FRAGMENT} }
            }`,
            { input: params },
            { signal },
          );
          return data.createViewFilter;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_view_filter_update",
        description:
          "Patch a ViewFilter. All fields except viewFilterId are optional.",
        mutates: true,
        parameters: UpdateViewFilterSchema,
        run: async (params, c, signal) => {
          const { viewFilterId, ...updates } = params;
          const data = await c.postGraphQL<{
            updateViewFilter: ViewFilterResponse;
          }>(
            `mutation UpdateViewFilter($input: UpdateViewFilterInput!) {
              updateViewFilter(input: $input) { ${VIEW_FILTER_FRAGMENT} }
            }`,
            { input: { id: viewFilterId, update: updates } },
            { signal },
          );
          return data.updateViewFilter;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_view_filter_delete",
        description:
          "Soft-delete a ViewFilter. The filter stops applying to the view " +
          "but remains restorable.",
        mutates: true,
        parameters: DeleteViewFilterSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            deleteViewFilter: ViewFilterResponse;
          }>(
            `mutation DeleteViewFilter($input: DeleteViewFilterInput!) {
              deleteViewFilter(input: $input) { ${VIEW_FILTER_FRAGMENT} }
            }`,
            { input: { id: params.viewFilterId } },
            { signal },
          );
          return data.deleteViewFilter;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_view_filter_destroy",
        description:
          "HARD-delete a ViewFilter. Irreversible. Approval-gated. " +
          "Prefer twenty_view_filter_delete for reversible removal.",
        mutates: true,
        parameters: DestroyViewFilterSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            destroyViewFilter: ViewFilterResponse;
          }>(
            `mutation DestroyViewFilter($input: DestroyViewFilterInput!) {
              destroyViewFilter(input: $input) { ${VIEW_FILTER_FRAGMENT} }
            }`,
            { input: { id: params.viewFilterId } },
            { signal },
          );
          return data.destroyViewFilter;
        },
      },
      client,
    ),

    // -------- ViewFilterGroup (3 tools) --------

    defineTwentyTool(
      {
        name: "twenty_view_filter_group_add",
        description:
          "Create a logical filter group (AND or OR). Filters added with " +
          "viewFilterGroupId set to this group's id are combined under " +
          "logicalOperator. Groups can nest by passing parentViewFilterGroupId.",
        mutates: true,
        parameters: AddViewFilterGroupSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            createViewFilterGroup: ViewFilterGroupResponse;
          }>(
            `mutation AddFilterGroup($input: CreateViewFilterGroupInput!) {
              createViewFilterGroup(input: $input) { ${VIEW_FILTER_GROUP_FRAGMENT} }
            }`,
            { input: params },
            { signal },
          );
          return data.createViewFilterGroup;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_view_filter_group_update",
        description:
          "Patch a ViewFilterGroup (logical operator AND↔OR, parent " +
          "regrouping, position).",
        mutates: true,
        parameters: UpdateViewFilterGroupSchema,
        run: async (params, c, signal) => {
          const { viewFilterGroupId, ...updates } = params;
          const data = await c.postGraphQL<{
            updateViewFilterGroup: ViewFilterGroupResponse;
          }>(
            `mutation UpdateFilterGroup(
              $id: String!, $input: UpdateViewFilterGroupInput!
            ) {
              updateViewFilterGroup(id: $id, input: $input) {
                ${VIEW_FILTER_GROUP_FRAGMENT}
              }
            }`,
            { id: viewFilterGroupId, input: updates },
            { signal },
          );
          return data.updateViewFilterGroup;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_view_filter_group_delete",
        description:
          "Soft-delete a ViewFilterGroup. Child filters become ungrouped.",
        mutates: true,
        parameters: DeleteViewFilterGroupSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{ deleteViewFilterGroup: boolean }>(
            `mutation DeleteFilterGroup($id: String!) {
              deleteViewFilterGroup(id: $id)
            }`,
            { id: params.viewFilterGroupId },
            { signal },
          );
          return {
            viewFilterGroupId: params.viewFilterGroupId,
            deleted: data.deleteViewFilterGroup === true,
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_view_filter_group_destroy",
        description:
          "HARD-delete a ViewFilterGroup. Irreversible. Approval-gated. " +
          "Prefer twenty_view_filter_group_delete for reversible removal.",
        mutates: true,
        parameters: DestroyViewFilterGroupSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{ destroyViewFilterGroup: boolean }>(
            `mutation DestroyFilterGroup($id: String!) {
              destroyViewFilterGroup(id: $id)
            }`,
            { id: params.viewFilterGroupId },
            { signal },
          );
          return {
            viewFilterGroupId: params.viewFilterGroupId,
            destroyed: data.destroyViewFilterGroup === true,
          };
        },
      },
      client,
    ),

    // -------- ViewSort (3 tools) --------

    defineTwentyTool(
      {
        name: "twenty_view_sort_add",
        description:
          "Add a sort criterion to a view (field + direction ASC/DESC). " +
          "Multiple sorts compose in insertion order — first added = " +
          "primary sort.",
        mutates: true,
        parameters: AddViewSortSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{ createViewSort: ViewSortResponse }>(
            `mutation AddViewSort($input: CreateViewSortInput!) {
              createViewSort(input: $input) { ${VIEW_SORT_FRAGMENT} }
            }`,
            { input: params },
            { signal },
          );
          return data.createViewSort;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_view_sort_update",
        description:
          "Patch a ViewSort (currently only direction is mutable in Twenty " +
          "2.1; field cannot be changed — delete and re-add to switch).",
        mutates: true,
        parameters: UpdateViewSortSchema,
        run: async (params, c, signal) => {
          const { viewSortId, ...updates } = params;
          const data = await c.postGraphQL<{ updateViewSort: ViewSortResponse }>(
            `mutation UpdateViewSort($input: UpdateViewSortInput!) {
              updateViewSort(input: $input) { ${VIEW_SORT_FRAGMENT} }
            }`,
            { input: { id: viewSortId, update: updates } },
            { signal },
          );
          return data.updateViewSort;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_view_sort_delete",
        description:
          "Soft-delete a ViewSort. Returns the deleted record id (Twenty " +
          "returns Boolean for this mutation in 2.1, so the plugin echoes " +
          "the input id back).",
        mutates: true,
        parameters: DeleteViewSortSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{ deleteViewSort: boolean }>(
            `mutation DeleteViewSort($input: DeleteViewSortInput!) {
              deleteViewSort(input: $input)
            }`,
            { input: { id: params.viewSortId } },
            { signal },
          );
          return {
            viewSortId: params.viewSortId,
            deleted: data.deleteViewSort === true,
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_view_sort_destroy",
        description:
          "HARD-delete a ViewSort. Irreversible. Approval-gated. " +
          "Prefer twenty_view_sort_delete for reversible removal.",
        mutates: true,
        parameters: DestroyViewSortSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{ destroyViewSort: boolean }>(
            `mutation DestroyViewSort($input: DestroyViewSortInput!) {
              destroyViewSort(input: $input)
            }`,
            { input: { id: params.viewSortId } },
            { signal },
          );
          return {
            viewSortId: params.viewSortId,
            destroyed: data.destroyViewSort === true,
          };
        },
      },
      client,
    ),

    // -------- ViewGroup (kanban columns, 3 tools) --------

    defineTwentyTool(
      {
        name: "twenty_view_group_add",
        description:
          "Add a kanban column (ViewGroup) to a KANBAN view. fieldValue " +
          "MUST match a value of the field declared as " +
          "view.mainGroupByFieldMetadataId. Position controls column order.",
        mutates: true,
        parameters: AddViewGroupSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            createViewGroup: ViewGroupResponse;
          }>(
            `mutation AddViewGroup($input: CreateViewGroupInput!) {
              createViewGroup(input: $input) { ${VIEW_GROUP_FRAGMENT} }
            }`,
            { input: params },
            { signal },
          );
          return data.createViewGroup;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_view_group_update",
        description:
          "Patch a ViewGroup (position, visibility). Group fieldValue is " +
          "immutable in Twenty 2.1.",
        mutates: true,
        parameters: UpdateViewGroupSchema,
        run: async (params, c, signal) => {
          const { viewGroupId, ...updates } = params;
          const data = await c.postGraphQL<{
            updateViewGroup: ViewGroupResponse;
          }>(
            `mutation UpdateViewGroup($input: UpdateViewGroupInput!) {
              updateViewGroup(input: $input) { ${VIEW_GROUP_FRAGMENT} }
            }`,
            { input: { id: viewGroupId, update: updates } },
            { signal },
          );
          return data.updateViewGroup;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_view_group_delete",
        description:
          "Soft-delete a ViewGroup (hide a kanban column). Records " +
          "previously in that column become uncategorised — they still " +
          "exist but no kanban column shows them until a new ViewGroup is " +
          "added with a matching fieldValue.",
        mutates: true,
        parameters: DeleteViewGroupSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            deleteViewGroup: ViewGroupResponse;
          }>(
            `mutation DeleteViewGroup($input: DeleteViewGroupInput!) {
              deleteViewGroup(input: $input) { ${VIEW_GROUP_FRAGMENT} }
            }`,
            { input: { id: params.viewGroupId } },
            { signal },
          );
          return data.deleteViewGroup;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_view_group_destroy",
        description:
          "HARD-delete a ViewGroup (kanban column). Irreversible. " +
          "Approval-gated. Prefer twenty_view_group_delete for reversible " +
          "removal.",
        mutates: true,
        parameters: DestroyViewGroupSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            destroyViewGroup: ViewGroupResponse;
          }>(
            `mutation DestroyViewGroup($input: DestroyViewGroupInput!) {
              destroyViewGroup(input: $input) { ${VIEW_GROUP_FRAGMENT} }
            }`,
            { input: { id: params.viewGroupId } },
            { signal },
          );
          return data.destroyViewGroup;
        },
      },
      client,
    ),
  ];
}

// Re-export TSchema-aware static type for tests that want to construct a
// ReorderViewFieldsInput literal.
export type _ViewsToolsSchema = TSchema;
