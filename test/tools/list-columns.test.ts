// Tests for the v0.8.0 PR2 List columns tools.
//
// We exercise:
//   - catalogue (5 tools registered with the expected names)
//   - set_size — single updateViewField mutation, no resolve dance
//   - set_order — resolveTableViewId + fetchViewFieldsWithMeta +
//     N updateViewField, with unknown fieldMetadataIds reported back

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveConfig } from "../../src/config.js";
import { buildListColumnsTools } from "../../src/tools/list-columns.js";
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
  tools: ReturnType<typeof buildListColumnsTools>,
  name: string,
): AnyTool {
  const tool = (tools as unknown as AnyTool[]).find((t) => t.name === name);
  assert.ok(tool, `tool ${name} should be registered`);
  return tool;
}

const EXPECTED_LC_TOOL_NAMES = [
  "twenty_list_columns_get",
  "twenty_list_columns_set_order",
  "twenty_list_columns_set_visibility",
  "twenty_list_column_set_size",
  "twenty_list_columns_reset_default",
];

describe("List-columns tool catalogue", () => {
  it("registers exactly the 5 expected tools", () => {
    const fetchImpl = captureFetch(() => ({ data: {} }), []);
    const client = makeClient(fetchImpl);
    const tools = buildListColumnsTools(client);
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...EXPECTED_LC_TOOL_NAMES].sort());
    assert.equal(tools.length, 5);
  });
});

describe("twenty_list_column_set_size", () => {
  it("issues a single updateViewField mutation with the new size", async () => {
    const calls: FetchCapture[] = [];
    const fetchImpl = captureFetch(
      () => ({
        data: { updateViewField: { id: "vf-1", size: 240 } },
      }),
      calls,
    );
    const client = makeClient(fetchImpl);
    const tool = findTool(
      buildListColumnsTools(client),
      "twenty_list_column_set_size",
    );
    const result = await tool.execute("call-1", {
      viewFieldId: "vf-1",
      size: 240,
    });

    assert.equal(calls.length, 1);
    const payload = JSON.parse(calls[0]!.body!);
    assert.match(payload.query, /updateViewField/);
    assert.equal(payload.variables.input.id, "vf-1");
    assert.equal(payload.variables.input.update.size, 240);
    assert.equal(result.details?.status, "ok");
  });
});

describe("twenty_list_columns_set_order", () => {
  it(
    "resolves the view, fetches viewFields, and updates positions; " +
      "unknown fieldMetadataIds are skipped without aborting",
    async () => {
      const calls: FetchCapture[] = [];
      const fetchImpl = captureFetch(
        ({ url, body }) => {
          // REST call to /rest/metadata/objects/<id> returns minimal
          // shape — list-columns tools only consume `data.object.fields`.
          if (url.includes("/rest/metadata/objects/")) {
            return {
              data: {
                object: {
                  fields: {
                    edges: [
                      {
                        node: {
                          id: "fm-name",
                          name: "name",
                          label: "Name",
                          type: "TEXT",
                        },
                      },
                      {
                        node: {
                          id: "fm-status",
                          name: "status",
                          label: "Status",
                          type: "SELECT",
                        },
                      },
                    ],
                  },
                },
              },
            };
          }
          const parsed = body ? JSON.parse(body) : {};
          const q = parsed.query as string;
          if (q.includes("getView(id:")) {
            return {
              data: {
                getView: {
                  id: "view-1",
                  name: "Index",
                  type: "TABLE",
                  key: "INDEX",
                  objectMetadataId: "obj-1",
                },
              },
            };
          }
          if (q.includes("getViewFields")) {
            return {
              data: {
                getViewFields: [
                  {
                    id: "vf-name",
                    fieldMetadataId: "fm-name",
                    isVisible: true,
                    position: 0,
                    size: 200,
                    aggregateOperation: null,
                  },
                  {
                    id: "vf-status",
                    fieldMetadataId: "fm-status",
                    isVisible: true,
                    position: 1,
                    size: 150,
                    aggregateOperation: null,
                  },
                ],
              },
            };
          }
          if (q.includes("updateViewField")) {
            return { data: { updateViewField: { id: "x", position: 0 } } };
          }
          return { data: {} };
        },
        calls,
      );
      const client = makeClient(fetchImpl);
      const tool = findTool(
        buildListColumnsTools(client),
        "twenty_list_columns_set_order",
      );
      const result = await tool.execute("call-1", {
        viewId: "view-1",
        // status first, name second, plus an unknown fm-rogue.
        orderedFieldMetadataIds: ["fm-status", "fm-name", "fm-rogue"],
      });

      assert.equal(result.details?.status, "ok");
      const data = result.details?.data as {
        updatedCount: number;
        skipped: string[];
      };
      assert.equal(data.updatedCount, 2);
      assert.deepEqual(data.skipped, ["fm-rogue"]);

      // Two updateViewField mutations should have fired with positions
      // 0 (fm-status → vf-status) and 1 (fm-name → vf-name).
      const updateCalls = calls.filter((c) =>
        c.body && JSON.parse(c.body).query?.includes("updateViewField"),
      );
      assert.equal(updateCalls.length, 2);
      const firstUpdate = JSON.parse(updateCalls[0]!.body!);
      assert.equal(firstUpdate.variables.input.id, "vf-status");
      assert.equal(firstUpdate.variables.input.update.position, 0);
      const secondUpdate = JSON.parse(updateCalls[1]!.body!);
      assert.equal(secondUpdate.variables.input.id, "vf-name");
      assert.equal(secondUpdate.variables.input.update.position, 1);
    },
  );
});

describe("twenty_list_columns_get — view type guard", () => {
  it("rejects a viewId that is not type=TABLE", async () => {
    const calls: FetchCapture[] = [];
    const fetchImpl = captureFetch(
      () => ({
        data: {
          getView: {
            id: "view-kanban",
            name: "Board",
            type: "KANBAN",
            key: null,
            objectMetadataId: "obj-1",
          },
        },
      }),
      calls,
    );
    const client = makeClient(fetchImpl);
    const tool = findTool(
      buildListColumnsTools(client),
      "twenty_list_columns_get",
    );
    const result = await tool.execute("call-1", { viewId: "view-kanban" });

    assert.equal(result.details?.status, "failed");
    assert.match(
      result.details?.error ?? "",
      /expected TABLE/,
    );
  });
});
