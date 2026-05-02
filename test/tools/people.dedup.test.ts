// Verifies `twenty_people_dedup` paginates through Twenty until the cap
// or `hasNextPage===false`, groups by `emails.primaryEmail`
// (case-insensitive), and only returns groups with 2+ records.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveConfig } from "../../src/config.js";
import { buildDedupTools } from "../../src/tools/dedup.js";
import { TwentyClient } from "../../src/twenty-client.js";

interface FetchCapture {
  url: string;
  init: RequestInit | undefined;
}

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

describe("twenty_people_dedup", () => {
  it("groups by primary email (case-insensitive) and skips singletons", async () => {
    const calls: FetchCapture[] = [];

    // Page 1: 2 records with the same email (different case → same group),
    // 1 record with a unique email, 1 record with no email (skipped).
    const PAGE_1 = {
      data: {
        people: [
          {
            id: "p-1",
            emails: { primaryEmail: "ada@acme.com" },
          },
          {
            id: "p-2",
            // Same email, different case — collide after lower-casing.
            emails: { primaryEmail: "ADA@acme.com" },
          },
          {
            id: "p-3",
            emails: { primaryEmail: "linus@kernel.org" },
          },
          {
            id: "p-4",
            emails: { primaryEmail: "" }, // skipped
          },
        ],
      },
      pageInfo: { hasNextPage: true, endCursor: "cur-1" },
      totalCount: 5,
    };
    // Page 2: a third record on the duplicate email + final record alone.
    const PAGE_2 = {
      data: {
        people: [
          { id: "p-5", emails: { primaryEmail: "ada@acme.com" } },
        ],
      },
      pageInfo: { hasNextPage: false, endCursor: null },
      totalCount: 5,
    };

    const config = resolveConfig({
      apiKey: "test-key",
      serverUrl: "https://crm.test.local",
      allowedWorkspaceIds: ["ws-1"],
      defaultWorkspaceId: "ws-1",
    });
    const client = new TwentyClient(config, silentLogger, {
      fetchImpl: sequenceFetch([PAGE_1, PAGE_2], calls),
    });

    const tool = buildDedupTools(client).find(
      (t) => t.name === "twenty_people_dedup",
    ) as unknown as {
      execute: (id: string, params: unknown) => Promise<{
        details?: { status: string; data?: unknown; error?: string };
      }>;
    } | undefined;
    assert.ok(tool, "twenty_people_dedup must be registered");

    // Use a `limit` larger than the total so pagination drives to
    // hasNextPage=false on its own.
    const result = await tool.execute("call-1", { limit: 200 });
    assert.equal(
      result.details?.status,
      "ok",
      `expected ok, got ${JSON.stringify(result.details)}`,
    );

    const data = result.details?.data as {
      scanned: number;
      pages: number;
      duplicate_count: number;
      groups: Array<{
        group_key: string;
        count: number;
        records: Array<{ id: string }>;
      }>;
    };
    assert.equal(data.scanned, 5);
    assert.equal(data.pages, 2);
    // Only one duplicate group (ada@acme.com), with 3 records.
    assert.equal(data.duplicate_count, 1);
    assert.equal(data.groups.length, 1);
    const group = data.groups[0]!;
    assert.equal(group.group_key, "ada@acme.com");
    assert.equal(group.count, 3);
    assert.deepEqual(
      group.records.map((r) => r.id).sort(),
      ["p-1", "p-2", "p-5"],
    );
  });
});
