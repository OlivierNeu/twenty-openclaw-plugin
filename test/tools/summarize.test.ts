// Verifies `twenty_summarize_relationship` issues 3 parallel calls for a
// Person target (noteTargets, taskTargets, calendarEventParticipants),
// extracts counts (using totalCount when present, length otherwise), and
// computes first/last_activity_at across all 3 join sets.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveConfig } from "../../src/config.js";
import { buildSummarizeTools } from "../../src/tools/summarize.js";
import { TwentyClient } from "../../src/twenty-client.js";

interface FetchCapture {
  url: string;
  init: RequestInit | undefined;
}

/**
 * Returns a `fetch` mock that routes by pathname so the 3 parallel
 * requests get the right payload regardless of the order they arrive in.
 */
function routedFetch(
  routes: Record<string, unknown>,
  capture: FetchCapture[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    capture.push({ url: String(input), init });
    const url = new URL(String(input));
    const payload = routes[url.pathname];
    if (payload === undefined) {
      return new Response(`{"error":"unrouted ${url.pathname}"}`, {
        status: 500,
      });
    }
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

describe("twenty_summarize_relationship", () => {
  it("merges note + task + calendar counts with timeline anchors", async () => {
    const calls: FetchCapture[] = [];

    const routes = {
      "/rest/noteTargets": {
        data: {
          noteTargets: [
            { id: "nt-1", createdAt: "2026-04-10T10:00:00.000Z" },
            { id: "nt-2", createdAt: "2026-04-25T10:00:00.000Z" },
          ],
        },
        pageInfo: { hasNextPage: false },
        totalCount: 2,
      },
      "/rest/taskTargets": {
        data: {
          taskTargets: [
            { id: "tt-1", createdAt: "2026-04-15T10:00:00.000Z" },
          ],
        },
        pageInfo: { hasNextPage: false },
        totalCount: 1,
      },
      "/rest/calendarEventParticipants": {
        data: {
          calendarEventParticipants: [
            { id: "cp-1", createdAt: "2026-04-05T10:00:00.000Z" },
            { id: "cp-2", createdAt: "2026-04-20T10:00:00.000Z" },
          ],
        },
        pageInfo: { hasNextPage: false },
        totalCount: 2,
      },
    };

    const config = resolveConfig({
      apiKey: "test-key",
      serverUrl: "https://crm.test.local",
      allowedWorkspaceIds: ["ws-1"],
      defaultWorkspaceId: "ws-1",
    });
    const client = new TwentyClient(config, silentLogger, {
      fetchImpl: routedFetch(routes, calls),
    });

    const tool = buildSummarizeTools(client).find(
      (t) => t.name === "twenty_summarize_relationship",
    ) as unknown as {
      execute: (id: string, params: unknown) => Promise<{
        details?: { status: string; data?: unknown; error?: string };
      }>;
    } | undefined;
    assert.ok(tool, "twenty_summarize_relationship must be registered");

    const result = await tool.execute("call-1", {
      target_type: "Person",
      target_id: "p-99",
      days: 60,
    });

    assert.equal(
      result.details?.status,
      "ok",
      `expected ok, got ${JSON.stringify(result.details)}`,
    );

    const data = result.details?.data as {
      target_type: string;
      target_id: string;
      window_days: number;
      counts: { notes: number; tasks: number; calendar_events: number };
      first_activity_at: string | null;
      last_activity_at: string | null;
      total_count: number;
    };

    assert.equal(data.target_type, "Person");
    assert.equal(data.target_id, "p-99");
    assert.equal(data.window_days, 60);
    assert.equal(data.counts.notes, 2);
    assert.equal(data.counts.tasks, 1);
    assert.equal(data.counts.calendar_events, 2);
    assert.equal(data.total_count, 5);

    // Earliest is the calendar 2026-04-05; latest is the note 2026-04-25.
    assert.equal(data.first_activity_at, "2026-04-05T10:00:00.000Z");
    assert.equal(data.last_activity_at, "2026-04-25T10:00:00.000Z");

    // Three calls — one per category for a Person target.
    assert.equal(calls.length, 3);
    const paths = new Set(
      calls.map((c) => new URL(c.url).pathname),
    );
    assert.ok(paths.has("/rest/noteTargets"));
    assert.ok(paths.has("/rest/taskTargets"));
    assert.ok(paths.has("/rest/calendarEventParticipants"));
  });
});
