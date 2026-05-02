// Verifies the generic record tools (P6 — 5 tools that operate on ANY
// Twenty entity by accepting `entity` plural name as a parameter).
//
// Coverage:
//   1. URL routing — `entity: "people"` produces `/rest/people` calls.
//   2. SECURITY — invalid `entity` (path traversal, query injection) is
//      rejected BEFORE the network call (`fetch` is never invoked). This
//      is the load-bearing guarantee of the regex validation.
//   3. Body forwarding — `record_create.data` is sent verbatim as the JSON
//      body without restructuring.
//
// Test count is intentionally tight (≤4) — the same factory + client paths
// are already exercised by the per-entity test files (`people.test.ts`,
// `companies.test.ts`, `metadata.objects.test.ts`).

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveConfig } from "../../src/config.js";
import { buildRecordTools } from "../../src/tools/records.js";
import { TwentyClient } from "../../src/twenty-client.js";

interface FetchCapture {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(
  payload: unknown,
  capture: FetchCapture[],
  status = 200,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    capture.push({ url: String(input), init });
    return new Response(JSON.stringify(payload), {
      status,
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

function buildClient(payload: unknown, calls: FetchCapture[], status = 200) {
  const config = resolveConfig({
    apiKey: "test-key",
    serverUrl: "https://crm.test.local",
    allowedWorkspaceIds: ["ws-1"],
    defaultWorkspaceId: "ws-1",
  });
  return new TwentyClient(config, silentLogger, {
    fetchImpl: fakeFetch(payload, calls, status),
  });
}

interface ToolHandle {
  name: string;
  execute: (id: string, params: unknown) => Promise<{
    details?: { status: string; data?: unknown; error?: string };
  }>;
}

function findTool(client: TwentyClient, name: string): ToolHandle {
  const tool = buildRecordTools(client).find((t) => t.name === name);
  if (!tool) {
    throw new Error(`tool ${name} not registered`);
  }
  return tool as unknown as ToolHandle;
}

describe("twenty_record_list", () => {
  it("routes `entity: 'people'` to GET /rest/people and unwraps `data.people`", async () => {
    const calls: FetchCapture[] = [];
    const client = buildClient(
      {
        data: { people: [{ id: "p-1" }, { id: "p-2" }] },
        pageInfo: { hasNextPage: false, startCursor: null, endCursor: null },
        totalCount: 2,
      },
      calls,
    );

    const tool = findTool(client, "twenty_record_list");
    const result = await tool.execute("call-1", { entity: "people", limit: 10 });

    assert.equal(
      result.details?.status,
      "ok",
      `expected ok, got ${JSON.stringify(result.details)}`,
    );
    const out = result.details?.data as { data: unknown[]; totalCount: number };
    assert.equal(out.data.length, 2);
    assert.equal(out.totalCount, 2);

    assert.equal(calls.length, 1);
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/rest/people");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(calls[0]!.init?.method, "GET");
  });
});

describe("twenty_record_list — entity validation", () => {
  it("rejects path-traversal entity BEFORE any network call", async () => {
    const calls: FetchCapture[] = [];
    const client = buildClient({}, calls);

    const tool = findTool(client, "twenty_record_list");
    const result = await tool.execute("call-bad", {
      entity: "people/../../etc/passwd",
    });

    // The factory must surface the regex failure as a tool-level failure.
    assert.equal(result.details?.status, "failed");
    assert.match(
      String(result.details?.error ?? ""),
      /entity/i,
      `expected error to mention entity, got: ${result.details?.error}`,
    );
    // CRITICAL — the URL must never have been built.
    assert.equal(
      calls.length,
      0,
      "fetch must not be called when entity validation fails",
    );
  });
});

describe("twenty_record_create", () => {
  it("forwards `data` verbatim as the POST body and unwraps the single-keyed envelope", async () => {
    const calls: FetchCapture[] = [];
    const client = buildClient(
      {
        data: {
          createIcopeDiagnostic: {
            id: "rec-1",
            someField: "hello",
          },
        },
      },
      calls,
      201,
    );

    const tool = findTool(client, "twenty_record_create");
    const result = await tool.execute("call-2", {
      entity: "icopeDiagnostics",
      data: { someField: "hello", other: 42 },
    });

    assert.equal(result.details?.status, "ok");
    const created = result.details?.data as { id: string; someField: string };
    assert.equal(created.id, "rec-1");
    assert.equal(created.someField, "hello");

    assert.equal(calls.length, 1);
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/rest/icopeDiagnostics");
    assert.equal(calls[0]!.init?.method, "POST");
    // Body is the `data` object, not the full params (the `entity` field
    // belongs to the path, not the JSON body Twenty receives).
    const body = JSON.parse(calls[0]!.init!.body as string);
    assert.deepEqual(body, { someField: "hello", other: 42 });
  });
});

describe("twenty_record_delete", () => {
  it("DELETEs /rest/<entity>/{id} with ?soft_delete=true and surfaces the unwrapped envelope", async () => {
    const calls: FetchCapture[] = [];
    const client = buildClient(
      { data: { deletePerson: { id: "rec-doomed" } } },
      calls,
    );

    const tool = findTool(client, "twenty_record_delete");
    const result = await tool.execute("call-3", {
      entity: "people",
      id: "rec-doomed",
    });

    assert.equal(result.details?.status, "ok");
    const payload = result.details?.data as { id: string };
    assert.equal(payload.id, "rec-doomed");

    assert.equal(calls.length, 1);
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/rest/people/rec-doomed");
    // Mirrors the per-entity *_delete contract — soft_delete on by default.
    assert.equal(url.searchParams.get("soft_delete"), "true");
    assert.equal(calls[0]!.init?.method, "DELETE");
  });
});
