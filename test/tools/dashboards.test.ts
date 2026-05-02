// Tests for the P7 dashboard tools.
//
// We exercise the GraphQL request shape (`postGraphQL` posts to
// `<serverUrl>/metadata` with the right query/variables), the cascade
// ordering in `twenty_dashboard_create_complete`, and the dispatch
// logic in `twenty_dashboard_widget_data`. Approval gating itself is
// covered by hooks/approval tests; here we only assert that the
// destructive widgets carry the right `mutates: true` flag, which is
// enforced by the read-only mode test in readonly.test.ts.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveConfig } from "../../src/config.js";
import { buildDashboardTools } from "../../src/tools/dashboards.js";
import { buildDashboardWidgetTools } from "../../src/tools/dashboard-widgets.js";
import { TwentyClient } from "../../src/twenty-client.js";

interface FetchCapture {
  url: string;
  init: RequestInit | undefined;
  body: string | undefined;
}

function captureFetch(
  responder: (req: { url: string; body: string | undefined }) => unknown,
  calls: FetchCapture[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body =
      typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, init, body });
    const payload = responder({ url, body });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeClient(fetchImpl: typeof fetch) {
  const config = resolveConfig({
    apiKey: "test-key",
    serverUrl: "https://crm.test.local",
    allowedWorkspaceIds: ["ws-1"],
    defaultWorkspaceId: "ws-1",
  });
  return new TwentyClient(config, silentLogger, { fetchImpl });
}

describe("twenty_dashboard_create_complete", () => {
  it(
    "cascades createPageLayout → POST /rest/dashboards → " +
      "createPageLayoutTab → N × createPageLayoutWidget in order",
    async () => {
      const calls: FetchCapture[] = [];
      const fetchImpl = captureFetch(({ body }) => {
        const parsed = body ? JSON.parse(body) : {};
        const q = parsed.query as string | undefined;

        if (!q) {
          // REST call to /rest/dashboards (POST)
          return {
            data: {
              createDashboard: {
                id: "dash-1",
                title: "Pipeline",
                pageLayoutId: "layout-1",
                position: 0,
                createdAt: "2026-05-02T00:00:00Z",
                updatedAt: "2026-05-02T00:00:00Z",
              },
            },
          };
        }
        // Order matters: createPageLayoutWidget / createPageLayoutTab
        // contain "createPageLayout" as a prefix. Match the most
        // specific name first.
        if (q.includes("createPageLayoutWidget")) {
          return {
            data: {
              createPageLayoutWidget: { id: `widget-${calls.length}`, title: "Total" },
            },
          };
        }
        if (q.includes("createPageLayoutTab")) {
          return {
            data: {
              createPageLayoutTab: { id: "tab-1", title: "Main", position: 0 },
            },
          };
        }
        if (q.includes("createPageLayout")) {
          return { data: { createPageLayout: { id: "layout-1", name: "Pipeline" } } };
        }
        return { data: {} };
      }, calls);

      const tools = buildDashboardTools(makeClient(fetchImpl));
      const tool = tools.find(
        (t) => t.name === "twenty_dashboard_create_complete",
      ) as unknown as {
        execute: (
          id: string,
          params: unknown,
        ) => Promise<{
          details: { status: string; data?: unknown; error?: string };
        }>;
      };
      assert.ok(tool, "twenty_dashboard_create_complete should be registered");

      const result = await tool.execute("call-1", {
        title: "Pipeline",
        widgets: [
          {
            title: "Total",
            type: "GRAPH",
            gridPosition: { row: 0, column: 0, rowSpan: 4, columnSpan: 4 },
            objectMetadataId: "obj-opp",
            configuration: {
              configurationType: "AGGREGATE_CHART",
              aggregateFieldMetadataId: "field-amount",
              aggregateOperation: "SUM",
            },
          },
          {
            title: "By stage",
            type: "GRAPH",
            gridPosition: { row: 0, column: 4, rowSpan: 8, columnSpan: 8 },
            objectMetadataId: "obj-opp",
            configuration: {
              configurationType: "BAR_CHART",
              aggregateFieldMetadataId: "field-amount",
              aggregateOperation: "COUNT",
              primaryAxisGroupByFieldMetadataId: "field-stage",
              layout: "VERTICAL",
            },
          },
        ],
      });

      assert.equal(result.details.status, "ok");
      const data = result.details.data as {
        dashboardId: string;
        pageLayoutId: string;
        firstTabId: string;
        widgetIds: string[];
        widgetCount: number;
      };
      assert.equal(data.dashboardId, "dash-1");
      assert.equal(data.pageLayoutId, "layout-1");
      assert.equal(data.firstTabId, "tab-1");
      assert.equal(data.widgetCount, 2);

      // Order assertion: layout (GraphQL /metadata) first, then dashboard
      // record (REST /rest/dashboards), then tab (GraphQL), then 2
      // widgets (GraphQL).
      // Extract the GraphQL field name (the camelCase identifier after
      // the opening `{`), not the operation name (`mutation CreateLayout`).
      const queries = calls.map(({ url, body }) =>
        url.endsWith("/metadata") && body
          ? (JSON.parse(body).query as string).match(/\{\s*(\w+)\s*\(/)?.[1] ??
            "metadata-other"
          : url.endsWith("/rest/dashboards")
            ? "rest-dashboard"
            : url,
      );

      // Expected: createPageLayout, rest-dashboard, createPageLayoutTab,
      // createPageLayoutWidget × 2.
      assert.equal(queries[0], "createPageLayout");
      assert.equal(queries[1], "rest-dashboard");
      assert.equal(queries[2], "createPageLayoutTab");
      assert.equal(queries[3], "createPageLayoutWidget");
      assert.equal(queries[4], "createPageLayoutWidget");
    },
  );
});

describe("twenty_dashboard_get", () => {
  it(
    "joins REST dashboard + GraphQL layout + tabs + widgets in one " +
      "tool call",
    async () => {
      const calls: FetchCapture[] = [];
      const fetchImpl = captureFetch(({ url, body }) => {
        if (url.includes("/rest/dashboards/")) {
          return {
            data: {
              dashboard: {
                id: "dash-1",
                title: "Pipeline",
                pageLayoutId: "layout-1",
                position: 0,
                createdAt: "2026-05-02T00:00:00Z",
                updatedAt: "2026-05-02T00:00:00Z",
              },
            },
          };
        }
        const parsed = body ? JSON.parse(body) : {};
        const q = parsed.query as string;
        // Specific before generic — `getPageLayoutWidgets` contains
        // `getPageLayout` as a prefix.
        if (q.includes("getPageLayoutWidgets")) {
          return {
            data: {
              getPageLayoutWidgets: [
                {
                  id: "widget-1",
                  title: "Total",
                  type: "GRAPH",
                  objectMetadataId: "obj-opp",
                  pageLayoutTabId: "tab-1",
                  gridPosition: { row: 0, column: 0, rowSpan: 4, columnSpan: 4 },
                  configuration: { configurationType: "AGGREGATE_CHART" },
                },
              ],
            },
          };
        }
        if (q.includes("getPageLayout")) {
          return {
            data: {
              getPageLayout: {
                id: "layout-1",
                name: "Pipeline",
                type: "DASHBOARD",
                objectMetadataId: null,
              },
              getPageLayoutTabs: [
                {
                  id: "tab-1",
                  title: "Main",
                  position: 0,
                  pageLayoutId: "layout-1",
                },
              ],
            },
          };
        }
        return { data: {} };
      }, calls);

      const tools = buildDashboardTools(makeClient(fetchImpl));
      const tool = tools.find(
        (t) => t.name === "twenty_dashboard_get",
      ) as unknown as {
        execute: (
          id: string,
          params: unknown,
        ) => Promise<{
          details: { status: string; data?: unknown; error?: string };
        }>;
      };
      const result = await tool.execute("call", { dashboardId: "dash-1" });

      assert.equal(result.details.status, "ok");
      const data = result.details.data as {
        dashboard: { id: string };
        pageLayout: { id: string; type: string } | null;
        tabs: Array<{ id: string; widgets: Array<{ id: string }> }>;
      };
      assert.equal(data.dashboard.id, "dash-1");
      assert.equal(data.pageLayout?.id, "layout-1");
      assert.equal(data.tabs.length, 1);
      assert.equal(data.tabs[0]!.widgets.length, 1);
      assert.equal(data.tabs[0]!.widgets[0]!.id, "widget-1");
    },
  );
});

describe("twenty_dashboard_widget_data", () => {
  it(
    "fetches the widget then dispatches to barChartData for " +
      "configurationType=BAR_CHART",
    async () => {
      const calls: FetchCapture[] = [];
      const fetchImpl = captureFetch(({ body }) => {
        const parsed = body ? JSON.parse(body) : {};
        const q = parsed.query as string;
        if (q.includes("getPageLayoutWidget")) {
          return {
            data: {
              getPageLayoutWidget: {
                id: "widget-1",
                type: "GRAPH",
                objectMetadataId: "obj-opp",
                configuration: {
                  configurationType: "BAR_CHART",
                  aggregateFieldMetadataId: "field-amount",
                  aggregateOperation: "COUNT",
                  primaryAxisGroupByFieldMetadataId: "field-stage",
                  layout: "VERTICAL",
                },
              },
            },
          };
        }
        if (q.includes("barChartData")) {
          return {
            data: {
              barChartData: {
                series: [{ key: "qualified", value: 12 }],
              },
            },
          };
        }
        // Should not call line/pie variants.
        throw new Error(`unexpected query: ${q.slice(0, 60)}`);
      }, calls);

      const tools = buildDashboardWidgetTools(makeClient(fetchImpl));
      const tool = tools.find(
        (t) => t.name === "twenty_dashboard_widget_data",
      ) as unknown as {
        execute: (
          id: string,
          params: unknown,
        ) => Promise<{
          details: { status: string; data?: unknown; error?: string };
        }>;
      };
      const result = await tool.execute("call", { widgetId: "widget-1" });

      assert.equal(result.details.status, "ok");
      const data = result.details.data as {
        configurationType: string;
        data: { series: Array<{ key: string; value: number }> };
      };
      assert.equal(data.configurationType, "BAR_CHART");
      assert.equal(data.data.series[0]!.value, 12);
      // Two GraphQL calls: getPageLayoutWidget then barChartData.
      assert.equal(calls.length, 2);
    },
  );

  it(
    "returns a hint (no chart-data resolver) for AGGREGATE_CHART KPI " +
      "configurations",
    async () => {
      const calls: FetchCapture[] = [];
      const fetchImpl = captureFetch(() => {
        return {
          data: {
            getPageLayoutWidget: {
              id: "widget-kpi",
              type: "GRAPH",
              objectMetadataId: "obj-opp",
              configuration: {
                configurationType: "AGGREGATE_CHART",
                aggregateFieldMetadataId: "field-amount",
                aggregateOperation: "SUM",
              },
            },
          },
        };
      }, calls);

      const tools = buildDashboardWidgetTools(makeClient(fetchImpl));
      const tool = tools.find(
        (t) => t.name === "twenty_dashboard_widget_data",
      ) as unknown as {
        execute: (
          id: string,
          params: unknown,
        ) => Promise<{
          details: { status: string; data?: unknown; error?: string };
        }>;
      };
      const result = await tool.execute("call", { widgetId: "widget-kpi" });

      assert.equal(result.details.status, "ok");
      const data = result.details.data as {
        configurationType: string;
        hint: string;
        data?: unknown;
      };
      assert.equal(data.configurationType, "AGGREGATE_CHART");
      assert.match(data.hint, /Single-KPI|aggregation/i);
      assert.equal(data.data, undefined);
      // Only one round trip: the dispatch fell through.
      assert.equal(calls.length, 1);
    },
  );
});

describe("postGraphQL error handling", () => {
  it(
    "raises a tool failure when Twenty returns a GraphQL `errors` array " +
      "with HTTP 200",
    async () => {
      const calls: FetchCapture[] = [];
      const fetchImpl = captureFetch(() => {
        return {
          errors: [
            {
              message:
                "PageLayout name must be a non-empty string [E_VALIDATION]",
            },
          ],
        };
      }, calls);

      const tools = buildDashboardTools(makeClient(fetchImpl));
      const tool = tools.find(
        (t) => t.name === "twenty_dashboard_create_complete",
      ) as unknown as {
        execute: (
          id: string,
          params: unknown,
        ) => Promise<{
          details: { status: string; data?: unknown; error?: string };
        }>;
      };
      const result = await tool.execute("call", {
        title: "",
        widgets: [],
      });

      assert.equal(result.details.status, "failed");
      assert.match(
        result.details.error ?? "",
        /PageLayout name must be a non-empty string/,
      );
    },
  );
});
