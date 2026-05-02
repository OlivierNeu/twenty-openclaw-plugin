// Verifies `twenty_people_find_similar` runs the email pass first and
// only falls back to the OR-on-name pass when the email search returns 0
// candidates. Validates the wire-format filter strings on both passes.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveConfig } from "../../src/config.js";
import { buildDedupTools } from "../../src/tools/dedup.js";
import { TwentyClient } from "../../src/twenty-client.js";

interface FetchCapture {
  url: string;
  init: RequestInit | undefined;
}

/**
 * Returns a `fetch` mock that serves a different payload on each call.
 * Mirrors the two-pass contract: pass 1 (email) → pass 2 (name).
 */
function sequenceFetch(
  payloads: unknown[],
  capture: FetchCapture[],
): typeof fetch {
  let i = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    capture.push({ url: String(input), init });
    const payload = payloads[i] ?? payloads[payloads.length - 1];
    i += 1;
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

function buildClient(payloads: unknown[], calls: FetchCapture[]) {
  const config = resolveConfig({
    apiKey: "test-key",
    serverUrl: "https://crm.test.local",
    allowedWorkspaceIds: ["ws-1"],
    defaultWorkspaceId: "ws-1",
  });
  return new TwentyClient(config, silentLogger, {
    fetchImpl: sequenceFetch(payloads, calls),
  });
}

function findTool(client: TwentyClient) {
  return buildDedupTools(client).find(
    (t) => t.name === "twenty_people_find_similar",
  ) as unknown as {
    execute: (id: string, params: unknown) => Promise<{
      details?: { status: string; data?: unknown; error?: string };
    }>;
  } | undefined;
}

describe("twenty_people_find_similar", () => {
  it("runs the email pass first; falls back to OR-on-name when email is empty", async () => {
    const calls: FetchCapture[] = [];
    // Pass 1 (email) returns 0 candidates → forces fallback.
    // Pass 2 (name) returns 2 candidates.
    const PAGE_EMPTY = { data: { people: [] }, pageInfo: {}, totalCount: 0 };
    const PAGE_NAME = {
      data: {
        people: [
          { id: "p-1", name: { firstName: "Wix-Team", lastName: "Bot" } },
          { id: "p-2", name: { firstName: "Joe", lastName: "Wix-Team" } },
        ],
      },
      pageInfo: {},
      totalCount: 2,
    };
    const client = buildClient([PAGE_EMPTY, PAGE_NAME], calls);
    const tool = findTool(client);
    assert.ok(tool, "twenty_people_find_similar must be registered");

    const result = await tool.execute("call-1", { query: "wix-team" });

    assert.equal(
      result.details?.status,
      "ok",
      `expected ok, got ${JSON.stringify(result.details)}`,
    );
    const data = result.details?.data as {
      query: string;
      candidates: Array<{ id: string }>;
      match_strategy: "email" | "name" | "none";
    };
    assert.equal(data.match_strategy, "name");
    assert.equal(data.candidates.length, 2);

    // Two HTTP calls: pass 1 = email filter, pass 2 = OR(name) filter.
    assert.equal(calls.length, 2);
    const url1 = new URL(calls[0]!.url);
    assert.equal(url1.pathname, "/rest/people");
    const filter1 = url1.searchParams.get("filter") ?? "";
    assert.ok(
      filter1.startsWith("emails.primaryEmail[ilike]:"),
      `pass 1 filter should target email: ${filter1}`,
    );
    assert.ok(filter1.includes("wix-team"), `pass 1 missing query: ${filter1}`);

    const url2 = new URL(calls[1]!.url);
    const filter2 = url2.searchParams.get("filter") ?? "";
    assert.ok(filter2.startsWith("or("), `pass 2 should be OR: ${filter2}`);
    assert.ok(
      filter2.includes("name.firstName[ilike]:"),
      `pass 2 missing firstName: ${filter2}`,
    );
    assert.ok(
      filter2.includes("name.lastName[ilike]:"),
      `pass 2 missing lastName: ${filter2}`,
    );
  });

  it("returns email strategy and DOES NOT call pass 2 when email pass has hits", async () => {
    const calls: FetchCapture[] = [];
    const PAGE_HIT = {
      data: {
        people: [
          {
            id: "p-9",
            emails: { primaryEmail: "wix-team@example.com" },
          },
        ],
      },
      pageInfo: {},
      totalCount: 1,
    };
    const client = buildClient([PAGE_HIT], calls);
    const tool = findTool(client);
    assert.ok(tool);

    const result = await tool.execute("call-1", { query: "wix-team" });
    const data = result.details?.data as {
      candidates: Array<{ id: string }>;
      match_strategy: "email" | "name" | "none";
    };
    assert.equal(data.match_strategy, "email");
    assert.equal(data.candidates.length, 1);
    // Only one HTTP call — the name fallback was skipped.
    assert.equal(calls.length, 1);
  });
});
