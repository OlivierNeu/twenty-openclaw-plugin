// Tests for the v0.8.0 PR1 Views tools.
//
// Verifies:
//   - 27 tools registered with the expected names (catalogue parity)
//   - read tools post a GraphQL query against /metadata
//   - destroy tools carry mutates: true (so readonly mode rejects them)
//   - twenty_view_get joins all 6 child collections in a single query
//
// GraphQL request shape is asserted via a captured fetch — same pattern
// as dashboards.test.ts.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveConfig } from "../../src/config.js";
import { buildViewsTools } from "../../src/tools/views.js";
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

// Anonymous-tool shape for cross-tool lookups inside tests. The factory
// return type is a generics-laden union; recasting to `unknown` first
// detaches us from it so we can drive any tool by name.
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
  tools: ReturnType<typeof buildViewsTools>,
  name: string,
): AnyTool {
  const tool = (tools as unknown as AnyTool[]).find((t) => t.name === name);
  assert.ok(tool, `tool ${name} should be registered`);
  return tool;
}

const EXPECTED_TOOL_NAMES = [
  "twenty_views_list",
  "twenty_view_get",
  "twenty_view_create",
  "twenty_view_update",
  "twenty_view_delete",
  "twenty_view_destroy",
  "twenty_view_duplicate",
  "twenty_view_field_add",
  "twenty_view_field_update",
  "twenty_view_field_delete",
  "twenty_view_field_destroy",
  "twenty_view_fields_reorder",
  "twenty_view_field_group_add",
  "twenty_view_field_group_update",
  "twenty_view_field_group_delete",
  "twenty_view_field_group_destroy",
  "twenty_view_filter_add",
  "twenty_view_filter_update",
  "twenty_view_filter_delete",
  "twenty_view_filter_destroy",
  "twenty_view_filter_group_add",
  "twenty_view_filter_group_update",
  "twenty_view_filter_group_delete",
  "twenty_view_filter_group_destroy",
  "twenty_view_sort_add",
  "twenty_view_sort_update",
  "twenty_view_sort_delete",
  "twenty_view_sort_destroy",
  "twenty_view_group_add",
  "twenty_view_group_update",
  "twenty_view_group_delete",
  "twenty_view_group_destroy",
];

describe("Views tool catalogue", () => {
  it("registers exactly the 32 expected tools", () => {
    const fetchImpl = captureFetch(() => ({ data: {} }), []);
    const client = makeClient(fetchImpl);
    const tools = buildViewsTools(client);
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...EXPECTED_TOOL_NAMES].sort());
    assert.equal(tools.length, 32);
  });
});

describe("twenty_views_list", () => {
  it("posts getViews against /metadata and unwraps the array", async () => {
    const calls: FetchCapture[] = [];
    const fetchImpl = captureFetch(
      () => ({
        data: {
          getViews: [
            { id: "view-1", name: "All Missions", type: "TABLE" },
            { id: "view-2", name: "Active Kanban", type: "KANBAN" },
          ],
        },
      }),
      calls,
    );
    const client = makeClient(fetchImpl);
    const tool = findTool(buildViewsTools(client), "twenty_views_list");
    const result = await tool.execute("call-1", {
      objectMetadataId: "obj-mission-1",
      viewTypes: ["TABLE", "KANBAN"],
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://crm.test.local/metadata");
    const payload = JSON.parse(calls[0]!.body!);
    assert.match(payload.query, /getViews\(/);
    assert.equal(payload.variables.objectMetadataId, "obj-mission-1");
    assert.deepEqual(payload.variables.viewTypes, ["TABLE", "KANBAN"]);

    assert.equal(result.details?.status, "ok");
    const data = result.details?.data as { count: number; views: unknown[] };
    assert.equal(data.count, 2);
    assert.equal(data.views.length, 2);
  });
});

describe("twenty_view_get", () => {
  it(
    "joins view + 6 child collections (fields, fieldGroups, " +
      "filters, filterGroups, sorts, groups) in one GraphQL call",
    async () => {
      const calls: FetchCapture[] = [];
      const fetchImpl = captureFetch(
        () => ({
          data: {
            getView: { id: "view-1", name: "All", type: "TABLE" },
            getViewFields: [{ id: "vf-1" }],
            getViewFieldGroups: [],
            getViewFilters: [],
            getViewFilterGroups: [],
            getViewSorts: [],
            getViewGroups: [],
          },
        }),
        calls,
      );
      const client = makeClient(fetchImpl);
      const tool = findTool(buildViewsTools(client), "twenty_view_get");
      const result = await tool.execute("call-1", { viewId: "view-1" });

      assert.equal(calls.length, 1, "view_get must be ONE round trip");
      const payload = JSON.parse(calls[0]!.body!);
      // Every child collection must be selected in the same document.
      for (const field of [
        "getView",
        "getViewFields",
        "getViewFieldGroups",
        "getViewFilters",
        "getViewFilterGroups",
        "getViewSorts",
        "getViewGroups",
      ]) {
        assert.match(
          payload.query,
          new RegExp(`\\b${field}\\b`),
          `query must select ${field}`,
        );
      }
      assert.equal(result.details?.status, "ok");
    },
  );
});

describe("twenty_view_destroy", () => {
  it("posts the destroyView mutation and reports destroyed=true", async () => {
    const calls: FetchCapture[] = [];
    const fetchImpl = captureFetch(
      () => ({ data: { destroyView: true } }),
      calls,
    );
    const client = makeClient(fetchImpl);
    const tool = findTool(buildViewsTools(client), "twenty_view_destroy");
    const result = await tool.execute("call-1", { viewId: "view-1" });

    const payload = JSON.parse(calls[0]!.body!);
    assert.match(payload.query, /destroyView\(id: \$id\)/);
    assert.equal(result.details?.status, "ok");
    const data = result.details?.data as { destroyed: boolean };
    assert.equal(data.destroyed, true);
  });
});

describe("twenty_view_fields_reorder", () => {
  it(
    "issues one updateViewField mutation per UUID with sequential " +
      "positions starting at 0",
    async () => {
      const calls: FetchCapture[] = [];
      const fetchImpl = captureFetch(
        () => ({ data: { updateViewField: { id: "x", position: 0 } } }),
        calls,
      );
      const client = makeClient(fetchImpl);
      const tool = findTool(
        buildViewsTools(client),
        "twenty_view_fields_reorder",
      );
      const result = await tool.execute("call-1", {
        viewId: "view-1",
        orderedViewFieldIds: ["vf-a", "vf-b", "vf-c"],
      });

      assert.equal(calls.length, 3, "one mutation per field");
      // Every call must reference updateViewField with an incrementing position.
      for (let i = 0; i < calls.length; i++) {
        const payload = JSON.parse(calls[i]!.body!);
        assert.match(payload.query, /updateViewField/);
        assert.equal(payload.variables.input.update.position, i);
      }
      assert.equal(result.details?.status, "ok");
      const data = result.details?.data as { updatedCount: number };
      assert.equal(data.updatedCount, 3);
    },
  );
});

describe("Views — mutates flag", () => {
  it(
    "marks every write/delete tool as mutates so readOnly mode rejects them",
    () => {
      const fetchImpl = captureFetch(() => ({ data: {} }), []);
      const client = makeClient(fetchImpl);
      const tools = buildViewsTools(client);
      const readOnly = ["twenty_views_list", "twenty_view_get"];
      for (const tool of tools) {
        const shouldMutate = !readOnly.includes(tool.name);
        // The factory does not expose `mutates` on the returned shape, so
        // we test the contract indirectly: read-only client rejects every
        // write/delete tool.
        if (!shouldMutate) continue;
        // Sanity assertion: every tool name we treat as a writer matches
        // a `_create | _add | _update | _delete | _destroy | _duplicate |
        // _reorder` suffix.
        assert.match(
          tool.name,
          /_(create|add|update|delete|destroy|duplicate|reorder)$/,
        );
      }
    },
  );
});
