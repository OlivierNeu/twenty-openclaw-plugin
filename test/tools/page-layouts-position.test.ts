// Non-regression tests for the v0.8.3 position-UNION auto-derivation
// behaviour on page-layout widget tools. Covers every code path:
//
//   - widget_add : auto-derive GRID variant from gridPosition when
//     `position` is omitted; honour explicit `position` for non-GRID tabs
//   - widget_update : same priority rules
//   - create_complete cascade : derive only when firstTabLayoutMode is
//     GRID/undefined, never on VERTICAL_LIST/CANVAS
//
// These tests assert what the plugin SENDS to Twenty (the GraphQL
// payload), not what Twenty stores — a captured-fetch mock lets us
// inspect each mutation input without a live Twenty instance.

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

// Extract the `input` argument from the captured GraphQL mutation body.
function extractMutationInput(
  call: FetchCapture,
): Record<string, unknown> | undefined {
  if (!call.body) return undefined;
  const parsed = JSON.parse(call.body);
  return parsed.variables?.input as Record<string, unknown>;
}

const STD_GRID = { row: 2, column: 0, rowSpan: 6, columnSpan: 4 };

// ---------------------------------------------------------------------------
// twenty_page_layout_widget_add
// ---------------------------------------------------------------------------

describe("twenty_page_layout_widget_add — position UNION auto-derivation", () => {
  it(
    "derives `position: { layoutMode: 'GRID', ... }` from gridPosition " +
      "when the agent does NOT supply `position` explicitly",
    async () => {
      const calls: FetchCapture[] = [];
      const fetchImpl = captureFetch(
        () => ({
          data: {
            createPageLayoutWidget: { id: "w-1", title: "Test", type: "GRAPH" },
          },
        }),
        calls,
      );
      const client = makeClient(fetchImpl);
      const tool = findTool(
        buildPageLayoutsTools(client),
        "twenty_page_layout_widget_add",
      );
      await tool.execute("call-1", {
        pageLayoutTabId: "tab-1",
        title: "KPI",
        type: "GRAPH",
        gridPosition: STD_GRID,
        objectMetadataId: "obj-1",
        configuration: {
          configurationType: "AGGREGATE_CHART",
          aggregateOperation: "COUNT",
        },
      });

      const input = extractMutationInput(calls[0]!);
      assert.ok(input, "must capture an input payload");
      assert.deepEqual(
        input!.gridPosition,
        STD_GRID,
        "gridPosition must be forwarded verbatim",
      );
      assert.deepEqual(
        input!.position,
        {
          layoutMode: "GRID",
          row: 2,
          column: 0,
          rowSpan: 6,
          columnSpan: 4,
        },
        "position must be auto-derived from gridPosition with layoutMode=GRID",
      );
    },
  );

  it(
    "honours an explicit `position` (VERTICAL_LIST variant) and does NOT " +
      "override it with the GRID derivation",
    async () => {
      const calls: FetchCapture[] = [];
      const fetchImpl = captureFetch(
        () => ({
          data: {
            createPageLayoutWidget: { id: "w-2", title: "Notes", type: "NOTES" },
          },
        }),
        calls,
      );
      const client = makeClient(fetchImpl);
      const tool = findTool(
        buildPageLayoutsTools(client),
        "twenty_page_layout_widget_add",
      );
      const explicitPosition = { layoutMode: "VERTICAL_LIST", index: 3 };
      await tool.execute("call-1", {
        pageLayoutTabId: "tab-vlist",
        title: "Notes",
        type: "NOTES",
        gridPosition: { row: 0, column: 0, rowSpan: 1, columnSpan: 12 },
        position: explicitPosition,
        configuration: { configurationType: "NOTES" },
      });

      const input = extractMutationInput(calls[0]!);
      assert.deepEqual(
        input!.position,
        explicitPosition,
        "explicit position must NOT be overridden by the GRID derivation",
      );
    },
  );

  it(
    "honours an explicit `position` (CANVAS variant) and does NOT " +
      "override it with the GRID derivation",
    async () => {
      const calls: FetchCapture[] = [];
      const fetchImpl = captureFetch(
        () => ({
          data: {
            createPageLayoutWidget: { id: "w-3", title: "C", type: "TIMELINE" },
          },
        }),
        calls,
      );
      const client = makeClient(fetchImpl);
      const tool = findTool(
        buildPageLayoutsTools(client),
        "twenty_page_layout_widget_add",
      );
      const explicitPosition = { layoutMode: "CANVAS" };
      await tool.execute("call-1", {
        pageLayoutTabId: "tab-canvas",
        title: "C",
        type: "TIMELINE",
        gridPosition: { row: 0, column: 0, rowSpan: 1, columnSpan: 12 },
        position: explicitPosition,
        configuration: { configurationType: "TIMELINE" },
      });

      const input = extractMutationInput(calls[0]!);
      assert.deepEqual(input!.position, explicitPosition);
    },
  );
});

// ---------------------------------------------------------------------------
// twenty_page_layout_widget_update
// ---------------------------------------------------------------------------

describe("twenty_page_layout_widget_update — position UNION auto-derivation", () => {
  it(
    "derives `position` from `gridPosition` when only gridPosition is " +
      "in the update payload (typical resize)",
    async () => {
      const calls: FetchCapture[] = [];
      const fetchImpl = captureFetch(
        () => ({
          data: {
            updatePageLayoutWidget: { id: "w-1", title: "T", type: "GRAPH" },
          },
        }),
        calls,
      );
      const client = makeClient(fetchImpl);
      const tool = findTool(
        buildPageLayoutsTools(client),
        "twenty_page_layout_widget_update",
      );
      await tool.execute("call-1", {
        widgetId: "w-1",
        gridPosition: { row: 4, column: 2, rowSpan: 8, columnSpan: 6 },
      });

      const input = extractMutationInput(calls[0]!);
      assert.deepEqual(input!.gridPosition, {
        row: 4,
        column: 2,
        rowSpan: 8,
        columnSpan: 6,
      });
      assert.deepEqual(input!.position, {
        layoutMode: "GRID",
        row: 4,
        column: 2,
        rowSpan: 8,
        columnSpan: 6,
      });
    },
  );

  it(
    "honours an explicit `position` in the update payload — the explicit " +
      "variant wins over the GRID derivation",
    async () => {
      const calls: FetchCapture[] = [];
      const fetchImpl = captureFetch(
        () => ({
          data: {
            updatePageLayoutWidget: { id: "w-1", title: "T", type: "TASKS" },
          },
        }),
        calls,
      );
      const client = makeClient(fetchImpl);
      const tool = findTool(
        buildPageLayoutsTools(client),
        "twenty_page_layout_widget_update",
      );
      const explicitPosition = { layoutMode: "VERTICAL_LIST", index: 0 };
      await tool.execute("call-1", {
        widgetId: "w-1",
        gridPosition: STD_GRID,
        position: explicitPosition,
      });

      const input = extractMutationInput(calls[0]!);
      assert.deepEqual(
        input!.position,
        explicitPosition,
        "explicit position must NOT be overridden",
      );
    },
  );

  it(
    "does NOT inject `position` when neither gridPosition nor position " +
      "are in the update payload (e.g. title-only update)",
    async () => {
      const calls: FetchCapture[] = [];
      const fetchImpl = captureFetch(
        () => ({
          data: {
            updatePageLayoutWidget: { id: "w-1", title: "T", type: "GRAPH" },
          },
        }),
        calls,
      );
      const client = makeClient(fetchImpl);
      const tool = findTool(
        buildPageLayoutsTools(client),
        "twenty_page_layout_widget_update",
      );
      await tool.execute("call-1", {
        widgetId: "w-1",
        title: "Renamed",
      });

      const input = extractMutationInput(calls[0]!);
      assert.equal(
        "position" in input!,
        false,
        "position must not be injected when no positional update is requested",
      );
      assert.equal(input!.title, "Renamed");
    },
  );
});

// ---------------------------------------------------------------------------
// twenty_page_layout_create_complete cascade
// ---------------------------------------------------------------------------

describe(
  "twenty_page_layout_create_complete — position derivation gated on firstTabLayoutMode",
  () => {
    function setupCascade(
      calls: FetchCapture[],
      capturedWidgetInputs: Array<Record<string, unknown>>,
    ) {
      return captureFetch(
        ({ body }) => {
          const parsed = body ? JSON.parse(body) : {};
          const q = parsed.query as string | undefined;
          if (q?.includes("createPageLayout(")) {
            return {
              data: {
                createPageLayout: {
                  id: "layout-1",
                  name: "L",
                  type: "DASHBOARD",
                },
              },
            };
          }
          if (q?.includes("createPageLayoutTab(")) {
            return {
              data: {
                createPageLayoutTab: {
                  id: "tab-cascade",
                  title: "Main",
                  position: 0,
                },
              },
            };
          }
          if (q?.includes("createPageLayoutWidget(")) {
            const input = parsed.variables?.input;
            if (input) capturedWidgetInputs.push(input);
            return {
              data: {
                createPageLayoutWidget: {
                  id: `widget-${capturedWidgetInputs.length}`,
                },
              },
            };
          }
          return { data: {} };
        },
        calls,
      );
    }

    it(
      "derives GRID position for each widget when firstTabLayoutMode " +
        "is undefined (default DASHBOARD case)",
      async () => {
        const calls: FetchCapture[] = [];
        const widgetInputs: Array<Record<string, unknown>> = [];
        const fetchImpl = setupCascade(calls, widgetInputs);
        const client = makeClient(fetchImpl);
        const tool = findTool(
          buildPageLayoutsTools(client),
          "twenty_page_layout_create_complete",
        );
        await tool.execute("call-1", {
          name: "Test",
          type: "DASHBOARD",
          widgets: [
            {
              title: "K1",
              type: "GRAPH",
              gridPosition: { row: 0, column: 0, rowSpan: 2, columnSpan: 3 },
              configuration: { configurationType: "AGGREGATE_CHART" },
            },
            {
              title: "K2",
              type: "GRAPH",
              gridPosition: { row: 0, column: 3, rowSpan: 2, columnSpan: 3 },
              configuration: { configurationType: "AGGREGATE_CHART" },
            },
          ],
        });

        assert.equal(widgetInputs.length, 2);
        for (const input of widgetInputs) {
          assert.ok(
            input.position,
            "every widget must have an auto-derived position",
          );
          assert.equal(
            (input.position as { layoutMode: string }).layoutMode,
            "GRID",
          );
        }
      },
    );

    it(
      "derives GRID position when firstTabLayoutMode === 'GRID' (explicit)",
      async () => {
        const calls: FetchCapture[] = [];
        const widgetInputs: Array<Record<string, unknown>> = [];
        const fetchImpl = setupCascade(calls, widgetInputs);
        const client = makeClient(fetchImpl);
        const tool = findTool(
          buildPageLayoutsTools(client),
          "twenty_page_layout_create_complete",
        );
        await tool.execute("call-1", {
          name: "T",
          type: "DASHBOARD",
          firstTabLayoutMode: "GRID",
          widgets: [
            {
              title: "W",
              type: "GRAPH",
              gridPosition: { row: 0, column: 0, rowSpan: 2, columnSpan: 3 },
              configuration: { configurationType: "AGGREGATE_CHART" },
            },
          ],
        });

        assert.equal(widgetInputs.length, 1);
        assert.equal(
          (widgetInputs[0]!.position as { layoutMode: string }).layoutMode,
          "GRID",
        );
      },
    );

    it(
      "DOES NOT inject `position` when firstTabLayoutMode === 'VERTICAL_LIST' " +
        "(Codex review fix: never force GRID variant on non-GRID tabs)",
      async () => {
        const calls: FetchCapture[] = [];
        const widgetInputs: Array<Record<string, unknown>> = [];
        const fetchImpl = setupCascade(calls, widgetInputs);
        const client = makeClient(fetchImpl);
        const tool = findTool(
          buildPageLayoutsTools(client),
          "twenty_page_layout_create_complete",
        );
        await tool.execute("call-1", {
          name: "RecordPage",
          type: "RECORD_PAGE",
          objectMetadataId: "obj-mission",
          firstTabLayoutMode: "VERTICAL_LIST",
          widgets: [
            {
              title: "FieldsBlock",
              type: "FIELDS",
              gridPosition: { row: 0, column: 0, rowSpan: 1, columnSpan: 12 },
              configuration: { configurationType: "FIELDS", viewId: "v-1" },
            },
          ],
        });

        assert.equal(widgetInputs.length, 1);
        assert.equal(
          "position" in widgetInputs[0]!,
          false,
          "position must not be injected on VERTICAL_LIST tabs",
        );
      },
    );

    it(
      "DOES NOT inject `position` when firstTabLayoutMode === 'CANVAS' " +
        "(Codex review fix)",
      async () => {
        const calls: FetchCapture[] = [];
        const widgetInputs: Array<Record<string, unknown>> = [];
        const fetchImpl = setupCascade(calls, widgetInputs);
        const client = makeClient(fetchImpl);
        const tool = findTool(
          buildPageLayoutsTools(client),
          "twenty_page_layout_create_complete",
        );
        await tool.execute("call-1", {
          name: "CanvasPage",
          type: "STANDALONE_PAGE",
          firstTabLayoutMode: "CANVAS",
          widgets: [
            {
              title: "Iframe",
              type: "IFRAME",
              gridPosition: { row: 0, column: 0, rowSpan: 1, columnSpan: 12 },
              configuration: {
                configurationType: "IFRAME",
                url: "https://example.com",
              },
            },
          ],
        });

        assert.equal(widgetInputs.length, 1);
        assert.equal(
          "position" in widgetInputs[0]!,
          false,
          "position must not be injected on CANVAS tabs",
        );
      },
    );
  },
);
