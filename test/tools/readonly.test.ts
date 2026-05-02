// Verifies that with `readOnly: true`, write tools are rejected at the
// plugin layer BEFORE any HTTP request is issued. The factory raises
// `TwentyReadOnlyError`, which `defineTwentyTool`'s try/catch translates
// into a `failed` tool result — `tool.execute` itself never throws.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveConfig } from "../../src/config.js";
import { buildPeopleTools } from "../../src/tools/people.js";
import { TwentyClient } from "../../src/twenty-client.js";

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("read-only mode", () => {
  it("blocks twenty_people_create before the network and surfaces a failed result", async () => {
    let networkHits = 0;
    const failingFetch: typeof fetch = (async () => {
      networkHits++;
      throw new Error(
        "fetch should NEVER be called when readOnly: true is set",
      );
    }) as typeof fetch;

    const config = resolveConfig({
      apiKey: "test-key",
      serverUrl: "https://crm.test.local",
      allowedWorkspaceIds: ["ws-1"],
      defaultWorkspaceId: "ws-1",
      readOnly: true,
    });
    const client = new TwentyClient(config, silentLogger, {
      fetchImpl: failingFetch,
    });

    const tool = buildPeopleTools(client).find(
      (t) => t.name === "twenty_people_create",
    ) as unknown as {
      execute: (id: string, params: unknown) => Promise<{
        details?: { status: string; error?: string };
      }>;
    } | undefined;
    assert.ok(tool, "twenty_people_create must be registered");

    const result = await tool.execute("call-readonly", {
      name: { firstName: "Test", lastName: "User" },
    });

    assert.equal(networkHits, 0, "fetch must NOT be called in read-only mode");
    assert.equal(result.details?.status, "failed");
    assert.match(
      result.details?.error ?? "",
      /read-only/i,
      `expected read-only error, got: ${result.details?.error}`,
    );
  });

  it("does NOT block read tools under readOnly", async () => {
    let networkHits = 0;
    const fakeFetch: typeof fetch = (async () => {
      networkHits++;
      return new Response(
        JSON.stringify({
          data: { people: [] },
          pageInfo: { hasNextPage: false },
          totalCount: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;

    const config = resolveConfig({
      apiKey: "test-key",
      serverUrl: "https://crm.test.local",
      allowedWorkspaceIds: ["ws-1"],
      defaultWorkspaceId: "ws-1",
      readOnly: true,
    });
    const client = new TwentyClient(config, silentLogger, {
      fetchImpl: fakeFetch,
    });

    const tool = buildPeopleTools(client).find(
      (t) => t.name === "twenty_people_list",
    ) as unknown as {
      execute: (id: string, params: unknown) => Promise<{
        details?: { status: string };
      }>;
    } | undefined;
    assert.ok(tool, "twenty_people_list must be registered");

    const result = await tool.execute("call-readonly-list", {});

    assert.equal(result.details?.status, "ok");
    assert.equal(networkHits, 1);
  });
});
