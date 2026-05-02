// Verifies `twenty_export` paginates through Twenty's list endpoint until
// `pageInfo.hasNextPage` flips false, concatenates the records, and
// renders both JSON and CSV correctly (with dot-notation flattening and
// CSV escaping for values containing commas/quotes/newlines).

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveConfig } from "../../src/config.js";
import { buildExportTools } from "../../src/tools/export.js";
import { TwentyClient } from "../../src/twenty-client.js";

interface FetchCapture {
  url: string;
  init: RequestInit | undefined;
}

/**
 * Returns a `fetch` mock that serves a different payload for each call —
 * mirrors Twenty's two-page pagination contract.
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

const PAGE_1 = {
  data: {
    people: [
      {
        id: "p-1",
        name: { firstName: "Ada", lastName: "Lovelace" },
        emails: { primaryEmail: "ada@example.com" },
      },
      {
        id: "p-2",
        // Trigger CSV escaping: the city contains a comma.
        name: { firstName: "Grace", lastName: "Hopper" },
        emails: { primaryEmail: 'grace"hopper@navy.mil' },
        city: "Arlington, VA",
      },
    ],
  },
  pageInfo: {
    hasNextPage: true,
    startCursor: "cur-start-1",
    endCursor: "cur-end-1",
  },
  totalCount: 3,
};

const PAGE_2 = {
  data: {
    people: [
      {
        id: "p-3",
        name: { firstName: "Linus", lastName: "Torvalds" },
        emails: { primaryEmail: "linus@kernel.org" },
      },
    ],
  },
  pageInfo: {
    hasNextPage: false,
    startCursor: "cur-start-2",
    endCursor: "cur-end-2",
  },
  totalCount: 3,
};

function buildClient(
  payloads: unknown[],
  calls: FetchCapture[],
): TwentyClient {
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
  return buildExportTools(client).find(
    (t) => t.name === "twenty_export",
  ) as unknown as {
    execute: (id: string, params: unknown) => Promise<{
      details?: { status: string; data?: unknown; error?: string };
    }>;
  } | undefined;
}

describe("twenty_export", () => {
  it("paginates two pages and returns the concatenated JSON array", async () => {
    const calls: FetchCapture[] = [];
    const client = buildClient([PAGE_1, PAGE_2], calls);
    const tool = findTool(client);
    assert.ok(tool, "twenty_export must be registered");

    const result = await tool.execute("call-1", {
      entity: "people",
      format: "json",
    });

    assert.equal(
      result.details?.status,
      "ok",
      `expected ok, got ${JSON.stringify(result.details)}`,
    );

    const data = result.details?.data as {
      format: string;
      entity: string;
      count: number;
      pages: number;
      data: Array<{ id: string }>;
    };
    assert.equal(data.format, "json");
    assert.equal(data.entity, "people");
    assert.equal(data.count, 3);
    assert.equal(data.pages, 2);
    assert.equal(data.data.length, 3);
    assert.deepEqual(
      data.data.map((r) => r.id),
      ["p-1", "p-2", "p-3"],
    );

    // First call: no startingAfter. Second call: startingAfter=cur-end-1.
    assert.equal(calls.length, 2);
    const url1 = new URL(calls[0]!.url);
    assert.equal(url1.pathname, "/rest/people");
    assert.equal(url1.searchParams.get("startingAfter"), null);
    assert.equal(url1.searchParams.get("limit"), "60");
    assert.equal(calls[0]!.init?.method, "GET");

    const url2 = new URL(calls[1]!.url);
    assert.equal(url2.pathname, "/rest/people");
    assert.equal(url2.searchParams.get("startingAfter"), "cur-end-1");
  });

  it("renders CSV with dot-notation columns and escapes commas/quotes", async () => {
    const calls: FetchCapture[] = [];
    const client = buildClient([PAGE_1, PAGE_2], calls);
    const tool = findTool(client);
    assert.ok(tool, "twenty_export must be registered");

    const result = await tool.execute("call-1", {
      entity: "people",
      format: "csv",
    });

    assert.equal(result.details?.status, "ok");
    const data = result.details?.data as {
      format: string;
      count: number;
      data: string;
    };
    assert.equal(data.format, "csv");
    assert.equal(data.count, 3);

    const csv = data.data;
    const lines = csv.trimEnd().split("\n");
    // Header row + 3 data rows.
    assert.equal(lines.length, 4);

    const header = lines[0]!;
    // Dot-notation flatten: `name.firstName`, `emails.primaryEmail`, ...
    assert.ok(header.includes("name.firstName"), `header missing name.firstName: ${header}`);
    assert.ok(header.includes("name.lastName"), `header missing name.lastName: ${header}`);
    assert.ok(header.includes("emails.primaryEmail"), `header missing emails.primaryEmail: ${header}`);
    assert.ok(header.includes("id"), `header missing id: ${header}`);

    // The Grace Hopper row contains a comma in `city` and a literal `"`
    // in the email — both must be quoted, and internal `"` doubled.
    const graceLine = lines.find((l) => l.includes("Grace"));
    assert.ok(graceLine, "expected a row containing Grace");
    assert.ok(
      graceLine.includes('"Arlington, VA"'),
      `comma value not quoted: ${graceLine}`,
    );
    assert.ok(
      graceLine.includes('"grace""hopper@navy.mil"'),
      `internal quote not doubled: ${graceLine}`,
    );
  });
});
