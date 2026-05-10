// Tests for the v0.8.0 PR3 Page Layout tools.
//
// Verifies:
//   - 17 tools registered with the expected names (catalogue parity
//     with openclaw.plugin.json contracts.tools)
//   - DASHBOARD-create cascade orchestrates POST /rest/dashboards
//   - non-DASHBOARD create skips the workspace record (RECORD_PAGE)
//   - widget_data dispatcher picks the right chart-data resolver

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveConfig } from "../../src/config.js";
import { buildPageLayoutsTools } from "../../src/tools/page-layouts.js";
import { TwentyClient } from "../../src/twenty-client.js";

interface FetchCapture {
  url: string;
  body: string | undefined;
}

function captureFetch(
  responder: (req: { url: string; body: string | undefined }) => unknown,
  calls: FetchCapture[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, body });
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

type AnyTool = {
  name: string;
  execute: (
    id: string,
    params: unknown,
  ) => Promise<{
    details: { status: string; data?: unknown; error?: string };
  }>;
};

function findTool(
  tools: ReturnType<typeof buildPageLayoutsTools>,
  name: string,
): AnyTool {
  const tool = (tools as unknown as AnyTool[]).find((t) => t.name === name);
  assert.ok(tool, `tool ${name} should be registered`);
  return tool;
}

const EXPECTED_PL_TOOL_NAMES = [
  "twenty_page_layouts_list",
  "twenty_page_layout_get",
  "twenty_page_layout_create",
  "twenty_page_layout_update",
  "twenty_page_layout_destroy",
  "twenty_page_layout_reset_to_default",
  "twenty_page_layout_duplicate",
  "twenty_page_layout_replace_with_tabs",
  "twenty_page_layout_create_complete",
  "twenty_page_layout_tab_add",
  "twenty_page_layout_tab_update",
  "twenty_page_layout_tab_destroy",
  "twenty_page_layout_tab_reset_to_default",
  "twenty_page_layout_widget_add",
  "twenty_page_layout_widget_update",
  "twenty_page_layout_widget_destroy",
  "twenty_page_layout_widget_reset_to_default",
  "twenty_page_layout_widget_data",
];

describe("Page-layouts tool catalogue", () => {
  it("registers exactly the 17 expected tools", () => {
    const fetchImpl = captureFetch(() => ({ data: {} }), []);
    const client = makeClient(fetchImpl);
    const tools = buildPageLayoutsTools(client);
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...EXPECTED_PL_TOOL_NAMES].sort());
    assert.equal(tools.length, EXPECTED_PL_TOOL_NAMES.length);
  });
});

describe("twenty_page_layout_create — DASHBOARD path", () => {
  it(
    "creates the PageLayout via GraphQL then POSTs /rest/dashboards " +
      "with the resolved layout id",
    async () => {
      const calls: FetchCapture[] = [];
      const fetchImpl = captureFetch(
        ({ url, body }) => {
          if (url.endsWith("/rest/dashboards")) {
            return {
              data: {
                createDashboard: {
                  id: "dash-1",
                  title: "Pipeline",
                  pageLayoutId: "layout-1",
                  position: 0,
                  createdAt: "2026-05-09T00:00:00Z",
                  updatedAt: "2026-05-09T00:00:00Z",
                },
              },
            };
          }
          // GraphQL createPageLayout mutation.
          const parsed = body ? JSON.parse(body) : {};
          if (parsed.query?.includes("createPageLayout")) {
            return {
              data: {
                createPageLayout: {
                  id: "layout-1",
                  name: "Pipeline",
                  type: "DASHBOARD",
                  objectMetadataId: null,
                },
              },
            };
          }
          return { data: {} };
        },
        calls,
      );
      const client = makeClient(fetchImpl);
      const tool = findTool(
        buildPageLayoutsTools(client),
        "twenty_page_layout_create",
      );
      const result = await tool.execute("call-1", {
        name: "Pipeline",
        type: "DASHBOARD",
      });

      assert.equal(result.details?.status, "ok");
      const data = result.details?.data as {
        pageLayout: { id: string; type: string };
        dashboard: { id: string } | null;
      };
      assert.equal(data.pageLayout.id, "layout-1");
      assert.equal(data.pageLayout.type, "DASHBOARD");
      assert.equal(data.dashboard?.id, "dash-1");

      // 1 GraphQL call (createPageLayout) + 1 REST call (POST /rest/dashboards).
      assert.equal(calls.length, 2);
      assert.match(calls[0]!.url, /\/metadata$/);
      assert.equal(calls[1]!.url, "https://crm.test.local/rest/dashboards");
    },
  );
});

describe("twenty_page_layout_create — RECORD_PAGE path", () => {
  it(
    "creates the layout without touching /rest/dashboards when " +
      "type=RECORD_PAGE and objectMetadataId is provided",
    async () => {
      const calls: FetchCapture[] = [];
      const fetchImpl = captureFetch(
        () => ({
          data: {
            createPageLayout: {
              id: "layout-2",
              name: "Mission detail",
              type: "RECORD_PAGE",
              objectMetadataId: "obj-mission",
            },
          },
        }),
        calls,
      );
      const client = makeClient(fetchImpl);
      const tool = findTool(
        buildPageLayoutsTools(client),
        "twenty_page_layout_create",
      );
      const result = await tool.execute("call-1", {
        name: "Mission detail",
        type: "RECORD_PAGE",
        objectMetadataId: "obj-mission",
      });

      assert.equal(result.details?.status, "ok");
      const data = result.details?.data as { dashboard: unknown };
      assert.equal(data.dashboard, null);
      // Single GraphQL call — no REST detour.
      assert.equal(calls.length, 1);
    },
  );

  it("rejects RECORD_PAGE create when objectMetadataId is missing", async () => {
    const fetchImpl = captureFetch(() => ({ data: {} }), []);
    const client = makeClient(fetchImpl);
    const tool = findTool(
      buildPageLayoutsTools(client),
      "twenty_page_layout_create",
    );
    const result = await tool.execute("call-1", {
      name: "Missing object",
      type: "RECORD_PAGE",
    });
    assert.equal(result.details?.status, "failed");
    assert.match(result.details?.error ?? "", /requires objectMetadataId/);
  });
});

describe("twenty_page_layout_widget_data — dispatcher", () => {
  it("picks barChartData when configurationType=BAR_CHART", async () => {
    const calls: FetchCapture[] = [];
    const fetchImpl = captureFetch(
      ({ body }) => {
        const parsed = body ? JSON.parse(body) : {};
        const q = parsed.query as string;
        if (q.includes("getPageLayoutWidget(")) {
          return {
            data: {
              getPageLayoutWidget: {
                id: "widget-1",
                type: "GRAPH",
                objectMetadataId: "obj-1",
                configuration: {
                  configurationType: "BAR_CHART",
                  primaryAxisGroupByFieldMetadataId: "fm-stage",
                },
              },
            },
          };
        }
        if (q.includes("barChartData")) {
          return {
            data: {
              barChartData: {
                data: [{ label: "Won", value: 10 }],
                indexBy: "stage",
                keys: ["value"],
              },
            },
          };
        }
        return { data: {} };
      },
      calls,
    );
    const client = makeClient(fetchImpl);
    const tool = findTool(
      buildPageLayoutsTools(client),
      "twenty_page_layout_widget_data",
    );
    const result = await tool.execute("call-1", { widgetId: "widget-1" });

    assert.equal(result.details?.status, "ok");
    const data = result.details?.data as {
      configurationType: string;
      data: unknown;
    };
    assert.equal(data.configurationType, "BAR_CHART");
    assert.ok(data.data);

    // Two GraphQL calls: getPageLayoutWidget + barChartData.
    assert.equal(calls.length, 2);
    assert.match(JSON.parse(calls[1]!.body!).query, /barChartData/);
  });

  it(
    "returns a hint (no chart-data call) for AGGREGATE_CHART KPI widgets",
    async () => {
      const calls: FetchCapture[] = [];
      const fetchImpl = captureFetch(
        () => ({
          data: {
            getPageLayoutWidget: {
              id: "widget-kpi",
              type: "GRAPH",
              objectMetadataId: "obj-1",
              configuration: { configurationType: "AGGREGATE_CHART" },
            },
          },
        }),
        calls,
      );
      const client = makeClient(fetchImpl);
      const tool = findTool(
        buildPageLayoutsTools(client),
        "twenty_page_layout_widget_data",
      );
      const result = await tool.execute("call-1", { widgetId: "widget-kpi" });

      assert.equal(result.details?.status, "ok");
      const data = result.details?.data as {
        configurationType: string;
        hint: string;
      };
      assert.equal(data.configurationType, "AGGREGATE_CHART");
      assert.match(data.hint, /KPI charts/);
      // Only ONE call — the dispatcher saw AGGREGATE_CHART and returned
      // the hint without hitting any chart-data endpoint.
      assert.equal(calls.length, 1);
    },
  );
});
