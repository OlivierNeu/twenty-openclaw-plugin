// Verifies that `twenty_companies_get` unwraps the `{ data: { company } }`
// envelope and URL-encodes the id segment.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveConfig } from "../../src/config.js";
import { buildCompaniesTools } from "../../src/tools/companies.js";
import { TwentyClient } from "../../src/twenty-client.js";

interface FetchCapture {
  url: string;
}

function fakeFetch(
  payload: unknown,
  capture: FetchCapture[],
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    capture.push({ url: String(input) });
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

describe("twenty_companies_get", () => {
  it("unwraps `data.company` and URL-encodes the id", async () => {
    const calls: FetchCapture[] = [];
    const config = resolveConfig({
      apiKey: "test-key",
      serverUrl: "https://crm.test.local",
      allowedWorkspaceIds: ["ws-1"],
      defaultWorkspaceId: "ws-1",
    });
    const client = new TwentyClient(config, silentLogger, {
      fetchImpl: fakeFetch(
        { data: { company: { id: "abc-123", name: "Acme Inc." } } },
        calls,
      ),
    });

    const tool = buildCompaniesTools(client).find(
      (t) => t.name === "twenty_companies_get",
    ) as unknown as {
      execute: (id: string, params: unknown) => Promise<{
        details?: { status: string; data?: unknown; error?: string };
      }>;
    } | undefined;
    assert.ok(tool, "twenty_companies_get must be registered");

    const result = await tool.execute("call-1", { id: "abc-123" });

    assert.equal(result.details?.status, "ok");
    const payload = result.details?.data as {
      id: string;
      name: string;
    } | null;
    assert.ok(payload, "expected non-null company payload");
    assert.equal(payload.id, "abc-123");
    assert.equal(payload.name, "Acme Inc.");

    assert.equal(calls.length, 1);
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/rest/companies/abc-123");
  });
});
