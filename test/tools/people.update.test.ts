// Verifies that `twenty_people_update` PATCHes /rest/people/{id} with the
// `id` stripped from the body, and unwraps `data.updatePerson`.

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

describe("twenty_people_update", () => {
  it("PATCHes /rest/people/{id} with id stripped from body and unwraps `data.updatePerson`", async () => {
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
            updatePerson: {
              id: "p-42",
              jobTitle: "CTO",
            },
          },
        },
        calls,
      ),
    });

    const tool = buildPeopleTools(client).find(
      (t) => t.name === "twenty_people_update",
    ) as unknown as {
      execute: (id: string, params: unknown) => Promise<{
        details?: { status: string; data?: unknown; error?: string };
      }>;
    } | undefined;
    assert.ok(tool, "twenty_people_update must be registered");

    const result = await tool.execute("call-1", {
      id: "p-42",
      jobTitle: "CTO",
    });

    assert.equal(
      result.details?.status,
      "ok",
      `expected ok, got ${JSON.stringify(result.details)}`,
    );

    const updated = result.details?.data as { id: string; jobTitle: string };
    assert.equal(updated.id, "p-42");
    assert.equal(updated.jobTitle, "CTO");

    // PATCH /rest/people/p-42, id removed from body.
    assert.equal(calls.length, 1);
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/rest/people/p-42");
    assert.equal(calls[0]!.init?.method, "PATCH");
    const body = JSON.parse(calls[0]!.init!.body as string);
    assert.equal(body.jobTitle, "CTO");
    assert.equal(
      "id" in body,
      false,
      "id MUST NOT appear in the PATCH body — path id is the source of truth",
    );
  });
});
