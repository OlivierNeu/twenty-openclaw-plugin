// Verifies that `twenty_people_create` POSTs to `/rest/people` with the
// JSON body untouched and unwraps the `data.createPerson` envelope.

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
  status = 201,
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

describe("twenty_people_create", () => {
  it("POSTs the body to /rest/people and unwraps `data.createPerson`", async () => {
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
            createPerson: {
              id: "p-new",
              name: { firstName: "Ada", lastName: "Lovelace" },
              emails: { primaryEmail: "ada@example.com" },
            },
          },
        },
        calls,
      ),
    });

    const tool = buildPeopleTools(client).find(
      (t) => t.name === "twenty_people_create",
    ) as unknown as {
      execute: (id: string, params: unknown) => Promise<{
        details?: { status: string; data?: unknown; error?: string };
      }>;
    } | undefined;
    assert.ok(tool, "twenty_people_create must be registered");

    const result = await tool.execute("call-1", {
      name: { firstName: "Ada", lastName: "Lovelace" },
      emails: { primaryEmail: "ada@example.com" },
      jobTitle: "Mathematician",
    });

    assert.equal(
      result.details?.status,
      "ok",
      `expected ok, got ${JSON.stringify(result.details)}`,
    );

    const created = result.details?.data as {
      id: string;
      name: { firstName: string; lastName: string };
      emails: { primaryEmail: string };
    };
    assert.equal(created.id, "p-new");
    assert.equal(created.name.firstName, "Ada");
    assert.equal(created.emails.primaryEmail, "ada@example.com");

    // One call to POST /rest/people with the JSON body.
    assert.equal(calls.length, 1);
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/rest/people");
    assert.equal(calls[0]!.init?.method, "POST");
    const body = JSON.parse(calls[0]!.init!.body as string);
    assert.equal(body.name.firstName, "Ada");
    assert.equal(body.emails.primaryEmail, "ada@example.com");
    assert.equal(body.jobTitle, "Mathematician");
    // The schema does not include a top-level `id` for create — verify
    // we did not accidentally inject one.
    assert.equal("id" in body, false);
  });
});
