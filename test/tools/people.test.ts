// Verifies that `twenty_people_list` parses Twenty's response shape
// (`{ data: { people: [...] }, pageInfo, totalCount }`) into the uniform
// `{ data: [...], pageInfo, totalCount }` envelope and that snake-case
// inputs are translated to camelCase query params on the wire.

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

describe("twenty_people_list", () => {
  it("unwraps `data.people` and exposes pageInfo + totalCount", async () => {
    const calls: FetchCapture[] = [];
    const config = resolveConfig({
      apiKey: "test-key",
      serverUrl: "https://crm.test.local",
      allowedWorkspaceIds: ["ws-1"],
      defaultWorkspaceId: "ws-1",
    });
    const client = new TwentyClient(config, silentLogger, {
      fetchImpl: fakeFetch(
        {
          data: {
            people: [
              { id: "p1", name: { firstName: "Ada" } },
              { id: "p2", name: { firstName: "Linus" } },
            ],
          },
          pageInfo: {
            hasNextPage: true,
            startCursor: "cursor-start",
            endCursor: "cursor-end",
          },
          totalCount: 42,
        },
        calls,
      ),
    });

    const tool = buildPeopleTools(client).find(
      (t) => t.name === "twenty_people_list",
    ) as unknown as {
      execute: (id: string, params: unknown) => Promise<{
        details?: { status: string; data?: unknown; error?: string };
      }>;
    } | undefined;
    assert.ok(tool, "twenty_people_list must be registered");

    const result = await tool.execute("call-1", {
      limit: 50,
      starting_after: "cursor-prev",
      filter: "firstName[eq]:Ada",
      order_by: "createdAt[DESC]",
    });

    assert.equal(
      result.details?.status,
      "ok",
      `expected ok, got ${JSON.stringify(result.details)}`,
    );

    const payload = result.details?.data as {
      data: unknown[];
      pageInfo: {
        hasNextPage: boolean;
        startCursor: string | null;
        endCursor: string | null;
      };
      totalCount: number | null;
    };

    // Unwrapped: `data` is an array of records (NOT { people: [...] }).
    assert.equal(Array.isArray(payload.data), true);
    assert.equal(payload.data.length, 2);
    assert.equal(payload.pageInfo.hasNextPage, true);
    assert.equal(payload.pageInfo.endCursor, "cursor-end");
    assert.equal(payload.pageInfo.startCursor, "cursor-start");
    assert.equal(payload.totalCount, 42);

    // Verify snake-case → camelCase translation on the wire.
    assert.equal(calls.length, 1);
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/rest/people");
    assert.equal(url.searchParams.get("startingAfter"), "cursor-prev");
    assert.equal(url.searchParams.get("orderBy"), "createdAt[DESC]");
    assert.equal(url.searchParams.get("filter"), "firstName[eq]:Ada");
    assert.equal(url.searchParams.get("limit"), "50");
    // `ending_before` was not provided — must NOT appear in the URL.
    assert.equal(url.searchParams.has("endingBefore"), false);
  });
});
