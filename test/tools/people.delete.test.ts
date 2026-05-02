// Verifies that `twenty_people_delete` DELETEs /rest/people/{id} with
// `?soft_delete=true` (per OpenAPI: default is HARD delete), and unwraps
// `data.deletePerson`.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveConfig } from "../../src/config.js";
import { buildPeopleTools } from "../../src/tools/people.js";
import { TwentyClient } from "../../src/twenty-client.js";

interface FetchCapture {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(
  payload: unknown,
  capture: FetchCapture[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    capture.push({ url: String(input), init });
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

describe("twenty_people_delete", () => {
  it("DELETEs /rest/people/{id}?soft_delete=true and unwraps `data.deletePerson`", async () => {
    const calls: FetchCapture[] = [];
    const config = resolveConfig({
      apiKey: "test-key",
      serverUrl: "https://crm.test.local",
      allowedWorkspaceIds: ["ws-1"],
      defaultWorkspaceId: "ws-1",
    });
    const client = new TwentyClient(config, silentLogger, {
      fetchImpl: fakeFetch(
        { data: { deletePerson: { id: "p-99" } } },
        calls,
      ),
    });

    const tool = buildPeopleTools(client).find(
      (t) => t.name === "twenty_people_delete",
    ) as unknown as {
      execute: (id: string, params: unknown) => Promise<{
        details?: { status: string; data?: unknown; error?: string };
      }>;
    } | undefined;
    assert.ok(tool, "twenty_people_delete must be registered");

    const result = await tool.execute("call-1", { id: "p-99" });

    assert.equal(
      result.details?.status,
      "ok",
      `expected ok, got ${JSON.stringify(result.details)}`,
    );

    const deleted = result.details?.data as { id: string };
    assert.equal(deleted.id, "p-99");

    // DELETE /rest/people/p-99?soft_delete=true — soft_delete MUST be
    // explicit because Twenty's OpenAPI default is hard delete.
    assert.equal(calls.length, 1);
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/rest/people/p-99");
    assert.equal(url.searchParams.get("soft_delete"), "true");
    assert.equal(calls[0]!.init?.method, "DELETE");
  });
});
