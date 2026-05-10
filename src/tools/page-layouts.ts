// Page layouts — Surface 2 of the v0.8.0 plugin extension.
//
// This module unifies what 0.7.x exposed as three separate dashboard
// tool sets (`dashboards.ts`, `dashboard-tabs.ts`, `dashboard-widgets.ts`).
// It covers EVERY Twenty page-layout type — `DASHBOARD`, `RECORD_PAGE`
// (record detail), `RECORD_INDEX` (object index), `STANDALONE_PAGE` —
// behind a single, generic vocabulary: `twenty_page_layout_*`,
// `twenty_page_layout_tab_*`, `twenty_page_layout_widget_*`.
//
// One asymmetry remains: DASHBOARD layouts also carry a workspace record
// in `/rest/dashboards`, while every other type is attached directly to
// `objectMetadataId`. The `_create` / `_destroy` / `_duplicate` tools
// handle that side-effect transparently — when the agent supplies
// `type: "DASHBOARD"` (or implies it via the underlying layout) the
// plugin orchestrates both halves; otherwise it operates on the
// PageLayout alone.

import { Type } from "@sinclair/typebox";

import { defineTwentyTool } from "./_factory.js";
import { WIDGET_CONFIGURATION_FRAGMENT } from "./widget-config-fragment.js";
import {
  GridPositionSchema,
  WidgetTypeSchema,
} from "./widget-schemas.js";
import type { TwentyClient } from "../twenty-client.js";

// ---------------------------------------------------------------------------
// Enum schemas — typed via TypeBox so the LLM can't supply wrong values.
// ---------------------------------------------------------------------------

const PageLayoutTypeSchema = Type.Union(
  [
    Type.Literal("RECORD_INDEX"),
    Type.Literal("RECORD_PAGE"),
    Type.Literal("DASHBOARD"),
    Type.Literal("STANDALONE_PAGE"),
  ],
  {
    description:
      "PageLayout type. RECORD_INDEX = object's list page; RECORD_PAGE " +
      "= record detail / show page; DASHBOARD = dashboard board; " +
      "STANDALONE_PAGE = workspace-wide page not bound to an object.",
  },
);

const PageLayoutTabLayoutModeSchema = Type.Union(
  [
    Type.Literal("GRID"),
    Type.Literal("VERTICAL_LIST"),
    Type.Literal("CANVAS"),
  ],
  {
    description:
      "Tab layout mode. GRID = 12-column grid (default for DASHBOARD); " +
      "VERTICAL_LIST = stacked rows (typical for RECORD_PAGE detail); " +
      "CANVAS = freeform absolute positions.",
  },
);

// ---------------------------------------------------------------------------
// Common shapes.
// ---------------------------------------------------------------------------

const PAGE_LAYOUT_FRAGMENT = `
  id name type objectMetadataId
  defaultTabToFocusOnMobileAndSidePanelId
  createdAt updatedAt deletedAt
`;

const PAGE_LAYOUT_TAB_FRAGMENT = `
  id pageLayoutId title position icon layoutMode
  isActive createdAt updatedAt deletedAt
`;

const PAGE_LAYOUT_WIDGET_FRAGMENT = `
  id pageLayoutTabId title type objectMetadataId
  conditionalDisplay conditionalAvailabilityExpression
  isActive createdAt updatedAt deletedAt
`;

interface PageLayoutResp {
  id: string;
  name: string;
  type: string;
  objectMetadataId: string | null;
  [key: string]: unknown;
}

interface PageLayoutTabResp {
  id: string;
  pageLayoutId: string;
  title: string;
  position: number;
  layoutMode: string | null;
  [key: string]: unknown;
}

interface PageLayoutWidgetResp {
  id: string;
  pageLayoutTabId: string;
  title: string;
  type: string;
  objectMetadataId: string | null;
  [key: string]: unknown;
}

interface DashboardRecord {
  id: string;
  title: string | null;
  pageLayoutId: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Schemas — top-level PageLayout.
// ---------------------------------------------------------------------------

const ListPageLayoutsSchema = Type.Object({
  objectMetadataId: Type.Optional(
    Type.String({
      description:
        "Filter by parent object UUID (omit to list every layout, " +
        "across every object). Required-ish for RECORD_PAGE / RECORD_INDEX " +
        "since those types are scoped to an object.",
    }),
  ),
  pageLayoutType: Type.Optional(
    PageLayoutTypeSchema,
  ),
});

const GetPageLayoutSchema = Type.Object({
  pageLayoutId: Type.String({ description: "PageLayout UUID" }),
});

const CreatePageLayoutSchema = Type.Object({
  name: Type.String({ description: "Layout name" }),
  type: PageLayoutTypeSchema,
  objectMetadataId: Type.Optional(
    Type.String({
      description:
        "Parent object UUID. REQUIRED for RECORD_INDEX / RECORD_PAGE; " +
        "optional for DASHBOARD / STANDALONE_PAGE.",
    }),
  ),
  // DASHBOARD-only — title surfaces in `/rest/dashboards`. When omitted,
  // `name` is reused.
  dashboardTitle: Type.Optional(
    Type.String({
      description:
        "Title of the workspace `dashboards` record created alongside " +
        "the PageLayout when type=DASHBOARD. Falls back to `name` when " +
        "absent. Ignored for other types.",
    }),
  ),
});

const UpdatePageLayoutSchema = Type.Object({
  pageLayoutId: Type.String(),
  name: Type.Optional(Type.String()),
  defaultTabToFocusOnMobileAndSidePanelId: Type.Optional(
    Type.Union([Type.String(), Type.Null()]),
  ),
});

const DestroyPageLayoutSchema = Type.Object({
  pageLayoutId: Type.String(),
});

const ResetPageLayoutSchema = Type.Object({
  pageLayoutId: Type.String(),
});

const DuplicatePageLayoutSchema = Type.Object({
  sourcePageLayoutId: Type.String({
    description: "PageLayout UUID to duplicate.",
  }),
  newName: Type.String(),
});

// `updatePageLayoutWithTabsAndWidgets` cascade.
const ReplaceWithTabsSchema = Type.Object({
  pageLayoutId: Type.String(),
  name: Type.String(),
  type: Type.Optional(PageLayoutTypeSchema),
  objectMetadataId: Type.Optional(Type.String()),
  tabs: Type.Array(
    Type.Object({
      id: Type.Optional(
        Type.String({
          description:
            "Existing tab UUID to keep, or omit to create a new tab.",
        }),
      ),
      title: Type.String(),
      position: Type.Optional(Type.Integer({ minimum: 0 })),
      icon: Type.Optional(Type.String()),
      layoutMode: Type.Optional(PageLayoutTabLayoutModeSchema),
      widgets: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.Optional(
              Type.String({
                description:
                  "Existing widget UUID to keep, or omit to create new.",
              }),
            ),
            title: Type.String(),
            type: WidgetTypeSchema,
            gridPosition: GridPositionSchema,
            objectMetadataId: Type.Optional(Type.String()),
            configuration: Type.Any(),
          }),
        ),
      ),
    }),
    {
      minItems: 1,
      description:
        "Full set of tabs replacing the current layout. Anything not " +
        "listed is destroyed.",
    },
  ),
});

const CreateCompleteSchema = Type.Object({
  name: Type.String(),
  type: PageLayoutTypeSchema,
  objectMetadataId: Type.Optional(Type.String()),
  dashboardTitle: Type.Optional(Type.String()),
  firstTabTitle: Type.Optional(
    Type.String({
      default: "Main",
      description: "Title of the first tab. Defaults to 'Main'.",
    }),
  ),
  firstTabLayoutMode: Type.Optional(PageLayoutTabLayoutModeSchema),
  widgets: Type.Optional(
    Type.Array(
      Type.Object({
        title: Type.String(),
        type: WidgetTypeSchema,
        gridPosition: GridPositionSchema,
        objectMetadataId: Type.Optional(Type.String()),
        configuration: Type.Any(),
      }),
      {
        description:
          "Widgets to create on the first tab. Order matches the array " +
          "(no implicit positioning — each entry MUST supply gridPosition).",
      },
    ),
  ),
});

// ---------------------------------------------------------------------------
// Schemas — Tabs.
// ---------------------------------------------------------------------------

const TabAddSchema = Type.Object({
  pageLayoutId: Type.String(),
  title: Type.String(),
  position: Type.Optional(
    Type.Integer({
      minimum: 0,
      description:
        "Tab position (0-based). When omitted, the plugin counts the " +
        "current tabs and appends.",
    }),
  ),
  icon: Type.Optional(Type.String()),
  layoutMode: Type.Optional(PageLayoutTabLayoutModeSchema),
});

const TabUpdateSchema = Type.Object({
  tabId: Type.String(),
  title: Type.Optional(Type.String()),
  position: Type.Optional(Type.Integer({ minimum: 0 })),
  icon: Type.Optional(Type.String()),
  layoutMode: Type.Optional(PageLayoutTabLayoutModeSchema),
});

const TabDestroySchema = Type.Object({
  tabId: Type.String(),
});

const TabResetSchema = Type.Object({
  tabId: Type.String(),
});

// ---------------------------------------------------------------------------
// Schemas — Widgets.
// ---------------------------------------------------------------------------

const WidgetAddSchema = Type.Object({
  pageLayoutTabId: Type.String(),
  title: Type.String(),
  type: WidgetTypeSchema,
  gridPosition: GridPositionSchema,
  objectMetadataId: Type.Optional(
    Type.String({
      description:
        "REQUIRED for type=GRAPH and type=RECORD_TABLE — UUID of the " +
        "Twenty object to aggregate or display.",
    }),
  ),
  configuration: Type.Any({
    description: "Widget configuration (shape depends on type).",
  }),
});

const WidgetUpdateSchema = Type.Object({
  widgetId: Type.String(),
  title: Type.Optional(Type.String()),
  type: Type.Optional(WidgetTypeSchema),
  gridPosition: Type.Optional(GridPositionSchema),
  objectMetadataId: Type.Optional(Type.String()),
  configuration: Type.Optional(Type.Any()),
  conditionalAvailabilityExpression: Type.Optional(Type.String()),
});

const WidgetDestroySchema = Type.Object({
  widgetId: Type.String(),
});

const WidgetResetSchema = Type.Object({
  widgetId: Type.String(),
});

const WidgetDataSchema = Type.Object({
  widgetId: Type.String({
    description:
      "Widget UUID. The plugin fetches the widget config and dispatches " +
      "to the right chart-data resolver (barChartData / lineChartData / " +
      "pieChartData) for chart widgets, or returns a hint for KPI " +
      "(AGGREGATE_CHART / GAUGE_CHART) configurations.",
  }),
});

interface WidgetFetched {
  id: string;
  type: string;
  objectMetadataId: string | null;
  configuration: { configurationType?: string } & Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tool builder.
// ---------------------------------------------------------------------------

export function buildPageLayoutsTools(client: TwentyClient) {
  return [
    // -------- PageLayout top-level (8 tools) --------

    defineTwentyTool(
      {
        name: "twenty_page_layouts_list",
        description:
          "List PageLayouts, optionally filtered by parent " +
          "objectMetadataId and/or by type (RECORD_INDEX/RECORD_PAGE/" +
          "DASHBOARD/STANDALONE_PAGE). Returns the layout summary " +
          "(no joined tabs/widgets — call twenty_page_layout_get for those).",
        parameters: ListPageLayoutsSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            getPageLayouts: PageLayoutResp[];
          }>(
            `query PageLayoutsList(
              $objectMetadataId: String, $pageLayoutType: PageLayoutType
            ) {
              getPageLayouts(
                objectMetadataId: $objectMetadataId,
                pageLayoutType: $pageLayoutType
              ) {
                ${PAGE_LAYOUT_FRAGMENT}
              }
            }`,
            {
              objectMetadataId: params.objectMetadataId ?? null,
              pageLayoutType: params.pageLayoutType ?? null,
            },
            { signal },
          );
          const layouts = data?.getPageLayouts ?? [];
          return { count: layouts.length, layouts };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_page_layout_get",
        description:
          "Fetch a PageLayout with its tabs and (per-tab) widgets joined. " +
          "When the layout is a DASHBOARD, the returned object also " +
          "carries the matching `/rest/dashboards` record so the agent " +
          "knows the corresponding workspace record id.",
        parameters: GetPageLayoutSchema,
        run: async (params, c, signal) => {
          const layoutData = await c.postGraphQL<{
            getPageLayout: PageLayoutResp | null;
            getPageLayoutTabs: PageLayoutTabResp[];
          }>(
            `query LayoutWithTabs($id: String!, $pageLayoutId: String!) {
              getPageLayout(id: $id) { ${PAGE_LAYOUT_FRAGMENT} }
              getPageLayoutTabs(pageLayoutId: $pageLayoutId) {
                ${PAGE_LAYOUT_TAB_FRAGMENT}
              }
            }`,
            { id: params.pageLayoutId, pageLayoutId: params.pageLayoutId },
            { signal },
          );
          const layout = layoutData?.getPageLayout;
          if (!layout) {
            throw new Error(`PageLayout ${params.pageLayoutId} not found`);
          }
          const tabs = layoutData?.getPageLayoutTabs ?? [];

          // Per-tab widgets — Twenty's getPageLayoutWidgets is scoped to
          // a single tab, so we issue one call per tab in parallel.
          const tabsWithWidgets = await Promise.all(
            tabs.map(async (tab) => {
              const widgetData = await c.postGraphQL<{
                getPageLayoutWidgets: PageLayoutWidgetResp[];
              }>(
                `query TabWidgets($pageLayoutTabId: String!) {
                  getPageLayoutWidgets(pageLayoutTabId: $pageLayoutTabId) {
                    ${PAGE_LAYOUT_WIDGET_FRAGMENT}
                  }
                }`,
                { pageLayoutTabId: tab.id },
                { signal },
              );
              return { ...tab, widgets: widgetData?.getPageLayoutWidgets ?? [] };
            }),
          );

          // For DASHBOARD layouts, fetch the matching workspace record.
          let dashboard: DashboardRecord | null = null;
          if (layout.type === "DASHBOARD") {
            const dashResp = await c.request<{
              data?: { dashboards?: DashboardRecord[] };
            }>("GET", "/rest/dashboards", {
              query: { filter: `pageLayoutId[eq]:${layout.id}` },
              signal,
            });
            const items = dashResp?.data?.dashboards ?? [];
            dashboard = items[0] ?? null;
          }

          return {
            pageLayout: layout,
            tabs: tabsWithWidgets,
            dashboard,
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_page_layout_create",
        description:
          "Create a PageLayout of any type. RECORD_INDEX and RECORD_PAGE " +
          "REQUIRE objectMetadataId. When type=DASHBOARD, the plugin also " +
          "creates the matching `/rest/dashboards` workspace record so " +
          "the layout appears in Twenty's Dashboards menu (titled by " +
          "`dashboardTitle` or, when absent, by `name`). Returns the " +
          "PageLayout (and, for DASHBOARD, the dashboard record).",
        mutates: true,
        parameters: CreatePageLayoutSchema,
        run: async (params, c, signal) => {
          if (
            (params.type === "RECORD_INDEX" || params.type === "RECORD_PAGE") &&
            !params.objectMetadataId
          ) {
            throw new Error(
              `twenty_page_layout_create: type=${params.type} requires ` +
                `objectMetadataId.`,
            );
          }

          const layoutData = await c.postGraphQL<{
            createPageLayout: PageLayoutResp;
          }>(
            `mutation CreateLayout($input: CreatePageLayoutInput!) {
              createPageLayout(input: $input) { ${PAGE_LAYOUT_FRAGMENT} }
            }`,
            {
              input: {
                name: params.name,
                type: params.type,
                objectMetadataId: params.objectMetadataId ?? null,
              },
            },
            { signal },
          );
          const pageLayout = layoutData.createPageLayout;

          let dashboard: DashboardRecord | null = null;
          if (params.type === "DASHBOARD") {
            const title = params.dashboardTitle ?? params.name;
            const dashResp = await c.request<{
              data?: { createDashboard?: DashboardRecord };
            }>("POST", "/rest/dashboards", {
              body: { title, pageLayoutId: pageLayout.id },
              signal,
            });
            dashboard = dashResp?.data?.createDashboard ?? null;
          }

          return { pageLayout, dashboard };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_page_layout_update",
        description:
          "Patch a PageLayout (name, default focused tab). For deeper " +
          "structural rewrites use twenty_page_layout_replace_with_tabs.",
        mutates: true,
        parameters: UpdatePageLayoutSchema,
        run: async (params, c, signal) => {
          const { pageLayoutId, ...updates } = params;
          const data = await c.postGraphQL<{
            updatePageLayout: PageLayoutResp;
          }>(
            `mutation UpdateLayout(
              $id: String!, $input: UpdatePageLayoutInput!
            ) {
              updatePageLayout(id: $id, input: $input) {
                ${PAGE_LAYOUT_FRAGMENT}
              }
            }`,
            { id: pageLayoutId, input: updates },
            { signal },
          );
          return data.updatePageLayout;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_page_layout_destroy",
        description:
          "HARD-delete a PageLayout (including every tab + widget). " +
          "Irreversible. Approval-gated. When the layout is a DASHBOARD, " +
          "the plugin also removes the matching `/rest/dashboards` " +
          "workspace record (soft-delete, restorable through the UI).",
        mutates: true,
        parameters: DestroyPageLayoutSchema,
        run: async (params, c, signal) => {
          // Step 1 — peek the layout to know whether to chase the
          // dashboard record.
          const peek = await c.postGraphQL<{
            getPageLayout: PageLayoutResp | null;
          }>(
            `query PeekLayout($id: String!) {
              getPageLayout(id: $id) { id type }
            }`,
            { id: params.pageLayoutId },
            { signal },
          );
          const isDashboard = peek?.getPageLayout?.type === "DASHBOARD";

          let dashboardSoftDeleted = false;
          if (isDashboard) {
            const dashResp = await c.request<{
              data?: { dashboards?: DashboardRecord[] };
            }>("GET", "/rest/dashboards", {
              query: { filter: `pageLayoutId[eq]:${params.pageLayoutId}` },
              signal,
            });
            const dash = dashResp?.data?.dashboards?.[0];
            if (dash?.id) {
              await c.request(
                "DELETE",
                `/rest/dashboards/${encodeURIComponent(dash.id)}`,
                { query: { soft_delete: true }, signal },
              );
              dashboardSoftDeleted = true;
            }
          }

          const data = await c.postGraphQL<{ destroyPageLayout: boolean }>(
            `mutation DestroyLayout($id: String!) {
              destroyPageLayout(id: $id)
            }`,
            { id: params.pageLayoutId },
            { signal },
          );

          return {
            pageLayoutId: params.pageLayoutId,
            destroyed: data.destroyPageLayout === true,
            dashboardSoftDeleted,
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_page_layout_reset_to_default",
        description:
          "Reset a PageLayout (and its tabs + widgets) to Twenty's " +
          "shipped defaults. Approval-gated — overwrites every tab and " +
          "widget on the layout.",
        mutates: true,
        parameters: ResetPageLayoutSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            resetPageLayoutToDefault: PageLayoutResp;
          }>(
            `mutation ResetLayout($id: String!) {
              resetPageLayoutToDefault(id: $id) { ${PAGE_LAYOUT_FRAGMENT} }
            }`,
            { id: params.pageLayoutId },
            { signal },
          );
          return data.resetPageLayoutToDefault;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_page_layout_duplicate",
        description:
          "Duplicate a PageLayout. For DASHBOARD layouts, this delegates " +
          "to Twenty's native `duplicateDashboard` mutation (clones the " +
          "dashboard record + the layout + tabs + widgets). For non-" +
          "DASHBOARD layouts, the plugin replays createPageLayout + " +
          "createPageLayoutTab + createPageLayoutWidget for each child.",
        mutates: true,
        parameters: DuplicatePageLayoutSchema,
        run: async (params, c, signal) => {
          // Discover the source type before deciding which path to take.
          const srcResp = await c.postGraphQL<{
            getPageLayout: PageLayoutResp | null;
            getPageLayoutTabs: PageLayoutTabResp[];
          }>(
            `query DupSource($id: String!, $pageLayoutId: String!) {
              getPageLayout(id: $id) { ${PAGE_LAYOUT_FRAGMENT} }
              getPageLayoutTabs(pageLayoutId: $pageLayoutId) {
                ${PAGE_LAYOUT_TAB_FRAGMENT}
              }
            }`,
            {
              id: params.sourcePageLayoutId,
              pageLayoutId: params.sourcePageLayoutId,
            },
            { signal },
          );
          const source = srcResp?.getPageLayout;
          if (!source) {
            throw new Error(
              `Source layout ${params.sourcePageLayoutId} not found`,
            );
          }

          if (source.type === "DASHBOARD") {
            // Find the dashboard record; Twenty's duplicateDashboard
            // mutation expects a dashboard UUID, not a pageLayout UUID.
            const dashResp = await c.request<{
              data?: { dashboards?: DashboardRecord[] };
            }>("GET", "/rest/dashboards", {
              query: {
                filter: `pageLayoutId[eq]:${params.sourcePageLayoutId}`,
              },
              signal,
            });
            const dashboardId = dashResp?.data?.dashboards?.[0]?.id;
            if (!dashboardId) {
              throw new Error(
                `DASHBOARD layout ${params.sourcePageLayoutId} has no ` +
                  `matching workspace record. Cannot use native ` +
                  `duplicateDashboard.`,
              );
            }
            const dupData = await c.postGraphQL<{
              duplicateDashboard: { id: string; pageLayoutId: string | null };
            }>(
              `mutation DupDashboard($id: UUID!) {
                duplicateDashboard(id: $id) { id pageLayoutId }
              }`,
              { id: dashboardId },
              { signal },
            );
            // Optionally rename the new dashboard record to the asked
            // name (Twenty defaults to "<source title> (copy)").
            if (dupData.duplicateDashboard.id) {
              await c.request(
                "PATCH",
                `/rest/dashboards/${encodeURIComponent(
                  dupData.duplicateDashboard.id,
                )}`,
                { body: { title: params.newName }, signal },
              );
            }
            return {
              strategy: "duplicateDashboard",
              dashboardId: dupData.duplicateDashboard.id,
              pageLayoutId: dupData.duplicateDashboard.pageLayoutId,
            };
          }

          // Non-DASHBOARD: manual replay.
          const newLayoutData = await c.postGraphQL<{
            createPageLayout: PageLayoutResp;
          }>(
            `mutation DupCreateLayout($input: CreatePageLayoutInput!) {
              createPageLayout(input: $input) { ${PAGE_LAYOUT_FRAGMENT} }
            }`,
            {
              input: {
                name: params.newName,
                type: source.type,
                objectMetadataId: source.objectMetadataId ?? null,
              },
            },
            { signal },
          );
          const newLayoutId = newLayoutData.createPageLayout.id;

          let copiedTabs = 0;
          let copiedWidgets = 0;
          for (const tab of srcResp?.getPageLayoutTabs ?? []) {
            const newTab = await c.postGraphQL<{
              createPageLayoutTab: { id: string };
            }>(
              `mutation DupCreateTab($input: CreatePageLayoutTabInput!) {
                createPageLayoutTab(input: $input) { id }
              }`,
              {
                input: {
                  pageLayoutId: newLayoutId,
                  title: tab.title,
                  position: tab.position,
                  icon: tab.icon ?? null,
                  layoutMode: tab.layoutMode ?? null,
                },
              },
              { signal },
            );
            copiedTabs++;

            const widgetData = await c.postGraphQL<{
              getPageLayoutWidgets: Array<
                PageLayoutWidgetResp & { configuration?: unknown }
              >;
            }>(
              `query DupSrcWidgets($pageLayoutTabId: String!) {
                getPageLayoutWidgets(pageLayoutTabId: $pageLayoutTabId) {
                  id title type objectMetadataId
                  gridPosition: position
                  configuration { ${WIDGET_CONFIGURATION_FRAGMENT} }
                }
              }`,
              { pageLayoutTabId: tab.id },
              { signal },
            );
            for (const widget of widgetData?.getPageLayoutWidgets ?? []) {
              await c.postGraphQL(
                `mutation DupCreateWidget($input: CreatePageLayoutWidgetInput!) {
                  createPageLayoutWidget(input: $input) { id }
                }`,
                {
                  input: {
                    pageLayoutTabId: newTab.createPageLayoutTab.id,
                    title: widget.title,
                    type: widget.type,
                    gridPosition: (
                      widget as { gridPosition?: unknown }
                    ).gridPosition,
                    objectMetadataId: widget.objectMetadataId ?? null,
                    configuration: (widget as { configuration?: unknown })
                      .configuration,
                  },
                },
                { signal },
              );
              copiedWidgets++;
            }
          }

          return {
            strategy: "manual",
            pageLayoutId: newLayoutId,
            copiedTabs,
            copiedWidgets,
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_page_layout_replace_with_tabs",
        description:
          "Atomically replace a PageLayout's entire tab+widget tree using " +
          "Twenty's bulk mutation `updatePageLayoutWithTabsAndWidgets`. " +
          "Tabs/widgets without an `id` are CREATED; those with `id` are " +
          "kept (and updated when fields differ); anything not listed is " +
          "DESTROYED. Approval-gated — DESTRUCTIVE on omission.",
        mutates: true,
        parameters: ReplaceWithTabsSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            updatePageLayoutWithTabsAndWidgets: { id: string; name: string };
          }>(
            `mutation Replace(
              $id: String!, $input: UpdatePageLayoutWithTabsInput!
            ) {
              updatePageLayoutWithTabsAndWidgets(id: $id, input: $input) {
                id name
              }
            }`,
            {
              id: params.pageLayoutId,
              input: {
                name: params.name,
                type: params.type,
                objectMetadataId: params.objectMetadataId ?? null,
                tabs: params.tabs,
              },
            },
            { signal },
          );
          return data.updatePageLayoutWithTabsAndWidgets;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_page_layout_create_complete",
        description:
          "Create a PageLayout in one cascade: layout + dashboards record " +
          "(when type=DASHBOARD) + first tab + N widgets. Returns the " +
          "layout id, the dashboard id (if applicable), the first tab " +
          "id, and the widget ids in creation order. The widget cascade " +
          "uses createPageLayoutWidget for each entry of `widgets`.",
        mutates: true,
        parameters: CreateCompleteSchema,
        run: async (params, c, signal) => {
          if (
            (params.type === "RECORD_INDEX" || params.type === "RECORD_PAGE") &&
            !params.objectMetadataId
          ) {
            throw new Error(
              `twenty_page_layout_create_complete: type=${params.type} ` +
                `requires objectMetadataId.`,
            );
          }

          // 1. Layout.
          const layoutData = await c.postGraphQL<{
            createPageLayout: PageLayoutResp;
          }>(
            `mutation CreateLayout($input: CreatePageLayoutInput!) {
              createPageLayout(input: $input) { id name type }
            }`,
            {
              input: {
                name: params.name,
                type: params.type,
                objectMetadataId: params.objectMetadataId ?? null,
              },
            },
            { signal },
          );
          const pageLayoutId = layoutData.createPageLayout.id;

          // 2. Dashboard record (DASHBOARD only).
          let dashboard: DashboardRecord | null = null;
          if (params.type === "DASHBOARD") {
            const title = params.dashboardTitle ?? params.name;
            const dashResp = await c.request<{
              data?: { createDashboard?: DashboardRecord };
            }>("POST", "/rest/dashboards", {
              body: { title, pageLayoutId },
              signal,
            });
            dashboard = dashResp?.data?.createDashboard ?? null;
          }

          // 3. First tab.
          const tabData = await c.postGraphQL<{
            createPageLayoutTab: { id: string; title: string; position: number };
          }>(
            `mutation CreateTab($input: CreatePageLayoutTabInput!) {
              createPageLayoutTab(input: $input) {
                id title position
              }
            }`,
            {
              input: {
                title: params.firstTabTitle ?? "Main",
                pageLayoutId,
                position: 0,
                layoutMode: params.firstTabLayoutMode ?? null,
              },
            },
            { signal },
          );
          const tabId = tabData.createPageLayoutTab.id;

          // 4. Widgets.
          const widgetIds: string[] = [];
          for (const widget of params.widgets ?? []) {
            const widgetData = await c.postGraphQL<{
              createPageLayoutWidget: { id: string };
            }>(
              `mutation CreateWidget($input: CreatePageLayoutWidgetInput!) {
                createPageLayoutWidget(input: $input) { id }
              }`,
              {
                input: {
                  pageLayoutTabId: tabId,
                  title: widget.title,
                  type: widget.type,
                  gridPosition: widget.gridPosition,
                  objectMetadataId: widget.objectMetadataId ?? null,
                  configuration: widget.configuration,
                },
              },
              { signal },
            );
            widgetIds.push(widgetData.createPageLayoutWidget.id);
          }

          return {
            pageLayoutId,
            type: params.type,
            dashboardId: dashboard?.id ?? null,
            firstTabId: tabId,
            widgetIds,
            widgetCount: widgetIds.length,
          };
        },
      },
      client,
    ),

    // -------- Tabs (4 tools) --------

    defineTwentyTool(
      {
        name: "twenty_page_layout_tab_add",
        description:
          "Add a tab to an existing PageLayout. Auto-positions at the " +
          "end when `position` is omitted (counts current tabs). Use " +
          "twenty_page_layout_widget_add to populate the new tab.",
        mutates: true,
        parameters: TabAddSchema,
        run: async (params, c, signal) => {
          let position = params.position;
          if (position === undefined) {
            const tabsResp = await c.postGraphQL<{
              getPageLayoutTabs: Array<{ position: number }>;
            }>(
              `query Tabs($pageLayoutId: String!) {
                getPageLayoutTabs(pageLayoutId: $pageLayoutId) { position }
              }`,
              { pageLayoutId: params.pageLayoutId },
              { signal },
            );
            position = (tabsResp?.getPageLayoutTabs ?? []).length;
          }

          const data = await c.postGraphQL<{
            createPageLayoutTab: PageLayoutTabResp;
          }>(
            `mutation CreateTab($input: CreatePageLayoutTabInput!) {
              createPageLayoutTab(input: $input) {
                ${PAGE_LAYOUT_TAB_FRAGMENT}
              }
            }`,
            {
              input: {
                title: params.title,
                pageLayoutId: params.pageLayoutId,
                position,
                icon: params.icon ?? null,
                layoutMode: params.layoutMode ?? null,
              },
            },
            { signal },
          );
          return data.createPageLayoutTab;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_page_layout_tab_update",
        description:
          "Patch a tab (title, position, icon, layoutMode). Only fields " +
          "you supply are modified.",
        mutates: true,
        parameters: TabUpdateSchema,
        run: async (params, c, signal) => {
          const { tabId, ...updates } = params;
          const data = await c.postGraphQL<{
            updatePageLayoutTab: PageLayoutTabResp;
          }>(
            `mutation UpdateTab(
              $id: String!, $input: UpdatePageLayoutTabInput!
            ) {
              updatePageLayoutTab(id: $id, input: $input) {
                ${PAGE_LAYOUT_TAB_FRAGMENT}
              }
            }`,
            { id: tabId, input: updates },
            { signal },
          );
          return data.updatePageLayoutTab;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_page_layout_tab_destroy",
        description:
          "HARD-delete a tab and every widget it contains. Irreversible. " +
          "Approval-gated. Sibling tab positions are NOT auto-compacted; " +
          "issue twenty_page_layout_tab_update if you want them tight.",
        mutates: true,
        parameters: TabDestroySchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{ destroyPageLayoutTab: boolean }>(
            `mutation DestroyTab($id: String!) {
              destroyPageLayoutTab(id: $id)
            }`,
            { id: params.tabId },
            { signal },
          );
          return {
            tabId: params.tabId,
            destroyed: data.destroyPageLayoutTab === true,
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_page_layout_tab_reset_to_default",
        description:
          "Reset a tab to Twenty's shipped default (regenerates widgets " +
          "from the standard template). Approval-gated.",
        mutates: true,
        parameters: TabResetSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            resetPageLayoutTabToDefault: PageLayoutTabResp;
          }>(
            `mutation ResetTab($id: String!) {
              resetPageLayoutTabToDefault(id: $id) {
                ${PAGE_LAYOUT_TAB_FRAGMENT}
              }
            }`,
            { id: params.tabId },
            { signal },
          );
          return data.resetPageLayoutTabToDefault;
        },
      },
      client,
    ),

    // -------- Widgets (5 tools) --------

    defineTwentyTool(
      {
        name: "twenty_page_layout_widget_add",
        description:
          "Add a widget to a tab. Use twenty_page_layout_get to find " +
          "the parent pageLayoutTabId.\n\n" +
          "GRID — 12 columns (0-11). KPI: rowSpan 2-4. Charts: rowSpan 6-8. " +
          "Full width: columnSpan 12, half: 6, third: 4.\n\n" +
          "WIDGET TYPE / configurationType decision tree:\n\n" +
          "  GRAPH + AGGREGATE_CHART (single KPI):\n" +
          "    requires objectMetadataId + configuration.{aggregateField" +
          "MetadataId, aggregateOperation}\n\n" +
          "  GRAPH + BAR_CHART:\n" +
          "    + primaryAxisGroupByFieldMetadataId + layout (VERTICAL|HORIZONTAL)\n" +
          "    + If grouping by RELATION/composite field, MUST set " +
          "primaryAxisGroupBySubFieldName ('name' / 'addressCity' / ...) " +
          "or it groups by raw UUID.\n\n" +
          "  GRAPH + LINE_CHART:\n" +
          "    + primaryAxisGroupByFieldMetadataId (typically a date field, " +
          "use primaryAxisDateGranularity = DAY|WEEK|MONTH|...)\n\n" +
          "  GRAPH + PIE_CHART:\n" +
          "    + groupByFieldMetadataId (NOTE: different field name from BAR/LINE)\n\n" +
          "  GRAPH + GAUGE_CHART:\n" +
          "    + aggregateFieldMetadataId + aggregateOperation + rangeMin + rangeMax\n\n" +
          "  RECORD_TABLE: + configuration.viewId (must create a TABLE view first).\n" +
          "  IFRAME: + configuration.url.\n" +
          "  STANDALONE_RICH_TEXT: + configuration.body.markdown.\n\n" +
          "AggregateOperations: COUNT, COUNT_UNIQUE_VALUES, COUNT_EMPTY, " +
          "COUNT_NOT_EMPTY, COUNT_TRUE, COUNT_FALSE, SUM, AVG, MIN, MAX, " +
          "PERCENTAGE_EMPTY, PERCENTAGE_NOT_EMPTY.",
        mutates: true,
        parameters: WidgetAddSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            createPageLayoutWidget: PageLayoutWidgetResp;
          }>(
            `mutation CreateWidget($input: CreatePageLayoutWidgetInput!) {
              createPageLayoutWidget(input: $input) {
                ${PAGE_LAYOUT_WIDGET_FRAGMENT}
              }
            }`,
            {
              input: {
                pageLayoutTabId: params.pageLayoutTabId,
                title: params.title,
                type: params.type,
                gridPosition: params.gridPosition,
                objectMetadataId: params.objectMetadataId ?? null,
                configuration: params.configuration,
              },
            },
            { signal },
          );
          return data.createPageLayoutWidget;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_page_layout_widget_update",
        description:
          "Patch a widget (title, type, gridPosition, objectMetadataId, " +
          "configuration, conditionalAvailabilityExpression). Only fields " +
          "you supply are modified.",
        mutates: true,
        parameters: WidgetUpdateSchema,
        run: async (params, c, signal) => {
          const { widgetId, ...updates } = params;
          const data = await c.postGraphQL<{
            updatePageLayoutWidget: PageLayoutWidgetResp;
          }>(
            `mutation UpdateWidget(
              $id: String!, $input: UpdatePageLayoutWidgetInput!
            ) {
              updatePageLayoutWidget(id: $id, input: $input) {
                ${PAGE_LAYOUT_WIDGET_FRAGMENT}
              }
            }`,
            { id: widgetId, input: updates },
            { signal },
          );
          return data.updatePageLayoutWidget;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_page_layout_widget_destroy",
        description:
          "HARD-delete a widget. Irreversible. Approval-gated.",
        mutates: true,
        parameters: WidgetDestroySchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{ destroyPageLayoutWidget: boolean }>(
            `mutation DestroyWidget($id: String!) {
              destroyPageLayoutWidget(id: $id)
            }`,
            { id: params.widgetId },
            { signal },
          );
          return {
            widgetId: params.widgetId,
            destroyed: data.destroyPageLayoutWidget === true,
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_page_layout_widget_reset_to_default",
        description:
          "Reset a widget to Twenty's shipped default. Approval-gated.",
        mutates: true,
        parameters: WidgetResetSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            resetPageLayoutWidgetToDefault: PageLayoutWidgetResp;
          }>(
            `mutation ResetWidget($id: String!) {
              resetPageLayoutWidgetToDefault(id: $id) {
                ${PAGE_LAYOUT_WIDGET_FRAGMENT}
              }
            }`,
            { id: params.widgetId },
            { signal },
          );
          return data.resetPageLayoutWidgetToDefault;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_page_layout_widget_data",
        description:
          "Compute the data for a chart widget (BAR/LINE/PIE). The plugin " +
          "fetches the widget config and dispatches to the right Twenty " +
          "chart-data resolver (barChartData / lineChartData / pieChartData). " +
          "For AGGREGATE_CHART / GAUGE_CHART (single KPI), returns a hint " +
          "pointing to the standard record-aggregation API — Twenty does " +
          "not expose dedicated chart-data resolvers for those.",
        parameters: WidgetDataSchema,
        run: async (params, c, signal) => {
          // 1. Fetch the widget to discover its type and configurationType.
          const widgetResp = await c.postGraphQL<{
            getPageLayoutWidget: WidgetFetched;
          }>(
            `query Widget($id: String!) {
              getPageLayoutWidget(id: $id) {
                id type objectMetadataId
                configuration { ${WIDGET_CONFIGURATION_FRAGMENT} }
              }
            }`,
            { id: params.widgetId },
            { signal },
          );
          const widget = widgetResp?.getPageLayoutWidget;
          if (!widget) {
            throw new Error(`Widget ${params.widgetId} not found`);
          }

          const cfgType = widget.configuration?.configurationType;
          if (!cfgType) {
            return {
              widgetId: widget.id,
              type: widget.type,
              hint: "Widget has no configurationType — cannot dispatch.",
            };
          }

          // 2. Dispatch to the right chart-data query.
          const BAR_FIELDS =
            "data indexBy keys " +
            "series { key label } " +
            "xAxisLabel yAxisLabel showLegend showDataLabels " +
            "layout groupMode hasTooManyGroups formattedToRawLookup";
          const LINE_FIELDS =
            "series { id label data { x y } } " +
            "xAxisLabel yAxisLabel showLegend showDataLabels " +
            "hasTooManyGroups formattedToRawLookup";
          const PIE_FIELDS =
            "data { id value } " +
            "showLegend showDataLabels showCenterMetric " +
            "hasTooManyGroups formattedToRawLookup";

          const dispatchMap: Record<string, { name: string; query: string }> = {
            BAR_CHART: {
              name: "barChartData",
              query: `query BarData($input: BarChartDataInput!) {
                barChartData(input: $input) { ${BAR_FIELDS} }
              }`,
            },
            LINE_CHART: {
              name: "lineChartData",
              query: `query LineData($input: LineChartDataInput!) {
                lineChartData(input: $input) { ${LINE_FIELDS} }
              }`,
            },
            PIE_CHART: {
              name: "pieChartData",
              query: `query PieData($input: PieChartDataInput!) {
                pieChartData(input: $input) { ${PIE_FIELDS} }
              }`,
            },
          };

          const dispatch = dispatchMap[cfgType];
          if (!dispatch) {
            return {
              widgetId: widget.id,
              type: widget.type,
              configurationType: cfgType,
              hint:
                cfgType === "AGGREGATE_CHART" || cfgType === "GAUGE_CHART"
                  ? "Single-KPI charts have no chart-data resolver. Use " +
                    "twenty_record_list with limit:0 + aggregateOperation, " +
                    "or pull totals via filters on the entity."
                  : `No chart-data resolver for configurationType=${cfgType}.`,
              configuration: widget.configuration,
            };
          }

          const data = await c.postGraphQL<Record<string, unknown>>(
            dispatch.query,
            {
              input: {
                objectMetadataId: widget.objectMetadataId,
                configuration: widget.configuration,
              },
            },
            { signal },
          );
          return {
            widgetId: widget.id,
            type: widget.type,
            configurationType: cfgType,
            data: data[dispatch.name],
          };
        },
      },
      client,
    ),
  ];
}
