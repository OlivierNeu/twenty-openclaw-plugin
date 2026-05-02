// Dashboard-level tools (P7).
//
// A Twenty dashboard is the union of two server-side concepts:
//   1. A `dashboards` workspace record (REST `/rest/dashboards`)
//      with `title`, `pageLayoutId`, `position`. Already CRUD-able via
//      the P6 generic record dispatch.
//   2. A `PageLayout` of `type=DASHBOARD` (GraphQL `/metadata`) holding
//      the tabs and widgets.
//
// These tools coordinate both: `create_complete` writes the layout
// first, then the dashboard record pointing at it, then walks the
// widget array. `delete` does the reverse. `get` joins the layout +
// tabs + widgets in a single call so the agent has one round trip to
// inspect a dashboard.

import { Type, type Static } from "@sinclair/typebox";

import { defineTwentyTool } from "./_factory.js";
import { WIDGET_CONFIGURATION_FRAGMENT } from "./widget-config-fragment.js";
import {
  GridPositionSchema,
  PageLayoutTypeSchema,
  WidgetTypeSchema,
} from "./widget-schemas.js";
import type { TwentyClient } from "../twenty-client.js";

// Inline widget input schema — same shape as `dashboard_widget_add` but
// embedded inside the create_complete cascade. Configuration is loose
// (`Type.Any()`) because TypeBox's discriminated unions are awkward for
// LLMs; Twenty validates server-side.
const InlineWidgetSchema = Type.Object({
  title: Type.String({ description: "Widget title" }),
  type: WidgetTypeSchema,
  gridPosition: GridPositionSchema,
  objectMetadataId: Type.Optional(
    Type.String({
      description:
        "REQUIRED for GRAPH and RECORD_TABLE widgets — UUID of the object " +
        "to aggregate or display.",
    }),
  ),
  configuration: Type.Any({
    description:
      "Widget configuration object. Shape depends on type+configurationType — " +
      "see twenty_dashboard_widget_add for the full schema list.",
  }),
});

const ListDashboardsSchema = Type.Object({
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 100, default: 20 }),
  ),
});

const GetDashboardSchema = Type.Object({
  dashboardId: Type.String({ description: "Dashboard record UUID" }),
});

const DuplicateDashboardSchema = Type.Object({
  id: Type.String({ description: "Source dashboard UUID" }),
});

const DeleteDashboardSchema = Type.Object({
  dashboardId: Type.String({ description: "Dashboard record UUID" }),
});

const CreateCompleteDashboardSchema = Type.Object({
  title: Type.String({ description: "Dashboard title" }),
  tabTitle: Type.Optional(
    Type.String({
      default: "Main",
      description: "Title of the first tab (defaults to 'Main')",
    }),
  ),
  widgets: Type.Optional(
    Type.Array(InlineWidgetSchema, {
      description:
        "Widgets to create on the first tab. Order matches the array " +
        "(no implicit positioning — supply gridPosition for each).",
    }),
  ),
  type: Type.Optional(PageLayoutTypeSchema),
});

const ReplaceLayoutSchema = Type.Object({
  pageLayoutId: Type.String({ description: "PageLayout UUID to replace" }),
  name: Type.String({ description: "Layout name (mirrors dashboard title)" }),
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

interface DashboardRecord {
  id: string;
  title: string | null;
  pageLayoutId: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

interface PageLayoutTabResp {
  id: string;
  title: string;
  position: number;
  pageLayoutId: string;
  layoutMode?: string;
}

interface PageLayoutWidgetResp {
  id: string;
  title: string;
  type: string;
  objectMetadataId: string | null;
  pageLayoutTabId: string;
  gridPosition: { row: number; column: number; rowSpan: number; columnSpan: number };
  configuration: unknown;
}

export function buildDashboardTools(client: TwentyClient) {
  return [
    defineTwentyTool(
      {
        name: "twenty_dashboards_list",
        description:
          "List dashboards in the workspace, ordered by position. " +
          "Returns id, title, pageLayoutId, createdAt, updatedAt for each.",
        parameters: ListDashboardsSchema,
        run: async (params, c, signal) => {
          const limit = params.limit ?? 20;
          const resp = await c.request<{
            data?: { dashboards?: DashboardRecord[] };
          }>("GET", "/rest/dashboards", {
            query: { limit, order_by: "position" },
            signal,
          });
          const dashboards = resp?.data?.dashboards ?? [];
          return {
            count: dashboards.length,
            dashboards: dashboards.map((d) => ({
              id: d.id,
              title: d.title,
              pageLayoutId: d.pageLayoutId,
              createdAt: d.createdAt,
              updatedAt: d.updatedAt,
            })),
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_dashboard_get",
        description:
          "Fetch a dashboard with its full layout (tabs + widgets) in " +
          "a single call. Returns the dashboard record, its PageLayout, " +
          "every tab, and every widget — enough to render or refactor.",
        parameters: GetDashboardSchema,
        run: async (params, c, signal) => {
          // 1. Dashboard record (REST).
          const dashResp = await c.request<{
            data?: { dashboard?: DashboardRecord };
          }>(
            "GET",
            `/rest/dashboards/${encodeURIComponent(params.dashboardId)}`,
            { signal },
          );
          const dashboard = dashResp?.data?.dashboard;
          if (!dashboard) {
            throw new Error(`Dashboard ${params.dashboardId} not found`);
          }
          if (!dashboard.pageLayoutId) {
            return { dashboard, pageLayout: null, tabs: [] };
          }

          // 2. PageLayout + tabs (one GraphQL call).
          const layoutData = await c.postGraphQL<{
            getPageLayout: {
              id: string;
              name: string;
              type: string;
              objectMetadataId: string | null;
            };
            getPageLayoutTabs: PageLayoutTabResp[];
          }>(
            `query DashboardLayout($id: String!, $pageLayoutId: String!) {
              getPageLayout(id: $id) { id name type objectMetadataId }
              getPageLayoutTabs(pageLayoutId: $pageLayoutId) {
                id title position pageLayoutId
              }
            }`,
            { id: dashboard.pageLayoutId, pageLayoutId: dashboard.pageLayoutId },
            { signal },
          );

          const tabs = layoutData?.getPageLayoutTabs ?? [];

          // 3. Widgets per tab (one GraphQL call per tab — Twenty's
          //    getPageLayoutWidgets is scoped to a single tab).
          const tabsWithWidgets = await Promise.all(
            tabs.map(async (tab) => {
              const widgetData = await c.postGraphQL<{
                getPageLayoutWidgets: PageLayoutWidgetResp[];
              }>(
                `query TabWidgets($pageLayoutTabId: String!) {
                  getPageLayoutWidgets(pageLayoutTabId: $pageLayoutTabId) {
                    id title type objectMetadataId pageLayoutTabId
                    gridPosition { row column rowSpan columnSpan }
                    configuration { ${WIDGET_CONFIGURATION_FRAGMENT} }
                  }
                }`,
                { pageLayoutTabId: tab.id },
                { signal },
              );
              return {
                ...tab,
                widgets: widgetData?.getPageLayoutWidgets ?? [],
              };
            }),
          );

          return {
            dashboard,
            pageLayout: layoutData?.getPageLayout ?? null,
            tabs: tabsWithWidgets,
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_dashboard_create_complete",
        description:
          "Create a complete dashboard in one cascade: PageLayout " +
          "(type=DASHBOARD) + dashboard record + first tab + N widgets. " +
          "Returns the dashboard id, layout id, tab id, and widget ids. " +
          "BEFORE calling, use twenty_metadata_objects_list to discover " +
          "objectMetadataId, and twenty_metadata_object_get to discover " +
          "field UUIDs (aggregate / groupBy). For GRAPH widgets see the " +
          "twenty_dashboard_widget_add description for the full " +
          "configuration schema.",
        mutates: true,
        parameters: CreateCompleteDashboardSchema,
        run: async (params, c, signal) => {
          // Step 1 — create the PageLayout.
          type LayoutMutation = { createPageLayout: { id: string; name: string } };
          const layoutData = await c.postGraphQL<LayoutMutation>(
            `mutation CreateLayout($input: CreatePageLayoutInput!) {
              createPageLayout(input: $input) { id name }
            }`,
            {
              input: {
                name: params.title,
                type: params.type ?? "DASHBOARD",
              },
            },
            { signal },
          );
          const pageLayoutId = layoutData.createPageLayout.id;

          // Step 2 — create the Dashboard workspace record.
          const dashResp = await c.request<{
            data?: { createDashboard?: DashboardRecord };
          }>("POST", "/rest/dashboards", {
            body: { title: params.title, pageLayoutId },
            signal,
          });
          const dashboard = dashResp?.data?.createDashboard;
          if (!dashboard) {
            throw new Error(
              "Twenty did not return a dashboard record — layout was created " +
                `(id=${pageLayoutId}). Run twenty_dashboards_list to recover.`,
            );
          }

          // Step 3 — create the first tab.
          type TabMutation = {
            createPageLayoutTab: { id: string; title: string; position: number };
          };
          const tabData = await c.postGraphQL<TabMutation>(
            `mutation CreateTab($input: CreatePageLayoutTabInput!) {
              createPageLayoutTab(input: $input) { id title position }
            }`,
            {
              input: {
                title: params.tabTitle ?? "Main",
                pageLayoutId,
                position: 0,
              },
            },
            { signal },
          );
          const tabId = tabData.createPageLayoutTab.id;

          // Step 4 — create each widget.
          const widgetIds: string[] = [];
          const widgets = params.widgets ?? [];
          for (const widget of widgets) {
            type WidgetMutation = {
              createPageLayoutWidget: { id: string; title: string };
            };
            const widgetData = await c.postGraphQL<WidgetMutation>(
              `mutation CreateWidget($input: CreatePageLayoutWidgetInput!) {
                createPageLayoutWidget(input: $input) { id title }
              }`,
              {
                input: {
                  pageLayoutTabId: tabId,
                  title: widget.title,
                  type: widget.type,
                  gridPosition: widget.gridPosition,
                  objectMetadataId: widget.objectMetadataId,
                  configuration: widget.configuration,
                },
              },
              { signal },
            );
            widgetIds.push(widgetData.createPageLayoutWidget.id);
          }

          return {
            dashboardId: dashboard.id,
            pageLayoutId,
            firstTabId: tabId,
            widgetIds,
            title: params.title,
            widgetCount: widgetIds.length,
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_dashboard_duplicate",
        description:
          "Duplicate an existing dashboard (records, layout, tabs, widgets) " +
          "into a new copy with the same content. Returns the new " +
          "dashboard id and pageLayoutId.",
        mutates: true,
        parameters: DuplicateDashboardSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            duplicateDashboard: { id: string; pageLayoutId: string | null };
          }>(
            `mutation Duplicate($id: UUID!) {
              duplicateDashboard(id: $id) { id pageLayoutId }
            }`,
            { id: params.id },
            { signal },
          );
          return data.duplicateDashboard;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_dashboard_delete",
        description:
          "HARD-delete a dashboard and its PageLayout (with every tab + " +
          "widget). Irreversible — no soft-delete on PageLayouts. Approval-" +
          "gated by default. Returns the deleted ids.",
        mutates: true,
        parameters: DeleteDashboardSchema,
        run: async (params, c, signal) => {
          // Resolve pageLayoutId before deleting the dashboard record so
          // we can chain the GraphQL destroy.
          const dashResp = await c.request<{
            data?: { dashboard?: DashboardRecord };
          }>(
            "GET",
            `/rest/dashboards/${encodeURIComponent(params.dashboardId)}`,
            { signal },
          );
          const dashboard = dashResp?.data?.dashboard;
          if (!dashboard) {
            throw new Error(`Dashboard ${params.dashboardId} not found`);
          }

          // Step 1 — soft-delete the dashboard record (no hard-delete on
          // workspace entities exposed in this plugin).
          await c.request(
            "DELETE",
            `/rest/dashboards/${encodeURIComponent(params.dashboardId)}`,
            { query: { soft_delete: true }, signal },
          );

          // Step 2 — destroy the PageLayout (HARD).
          let layoutDestroyed = false;
          if (dashboard.pageLayoutId) {
            const data = await c.postGraphQL<{ destroyPageLayout: boolean }>(
              `mutation DestroyLayout($id: String!) {
                destroyPageLayout(id: $id)
              }`,
              { id: dashboard.pageLayoutId },
              { signal },
            );
            layoutDestroyed = data.destroyPageLayout === true;
          }

          return {
            dashboardId: params.dashboardId,
            pageLayoutId: dashboard.pageLayoutId,
            layoutDestroyed,
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_dashboard_replace_layout",
        description:
          "Atomically replace a dashboard's entire layout (tabs + " +
          "widgets) using Twenty's bulk mutation `updatePageLayoutWith" +
          "TabsAndWidgets`. Tabs/widgets without an `id` are created; " +
          "those with `id` are updated; anything not listed is destroyed. " +
          "Approval-gated by default — atomic but DESTRUCTIVE.",
        mutates: true,
        parameters: ReplaceLayoutSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            updatePageLayoutWithTabsAndWidgets: {
              id: string;
              name: string;
            };
          }>(
            `mutation Replace($id: String!, $input: UpdatePageLayoutWithTabsInput!) {
              updatePageLayoutWithTabsAndWidgets(id: $id, input: $input) {
                id name
              }
            }`,
            {
              id: params.pageLayoutId,
              input: {
                name: params.name,
                type: params.type ?? "DASHBOARD",
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
  ];
}

// Helper exported for live smoke-testing only — not used by the build.
export type CreateCompleteDashboardInput = Static<
  typeof CreateCompleteDashboardSchema
>;
