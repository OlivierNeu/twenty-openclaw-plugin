// Verifies that `twenty_activities_list_for` injects the right
// `target<Type>Id[eq]:<id>` filter for each target_type and joins the
// noteTargets + taskTargets responses into the bespoke output shape.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveConfig } from "../../src/config.js";
import { buildActivitiesTools } from "../../src/tools/activities.js";
import { TwentyClient } from "../../src/twenty-client.js";

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface FetchCapture {
  url: string;
}

function multiFakeFetch(capture: FetchCapture[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    capture.push({ url });
    if (url.includes("/noteTargets")) {
      return new Response(
        JSON.stringify({
          data: {
            noteTargets: [
              {
                id: "nt-1",
                noteId: "n-1",
                createdAt: "2026-04-01T00:00:00Z",
                note: { id: "n-1", title: "Kick-off" },
              },
            ],
          },
          totalCount: 1,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    if (url.includes("/taskTargets")) {
      return new Response(
        JSON.stringify({
          data: {
            taskTargets: [
              {
                id: "tt-1",
                taskId: "t-1",
                createdAt: "2026-04-02T00:00:00Z",
                task: { id: "t-1", title: "Send proposal" },
              },
              {
                id: "tt-2",
                taskId: "t-2",
                createdAt: "2026-04-03T00:00:00Z",
                task: { id: "t-2", title: "Schedule call" },
              },
            ],
          },
          totalCount: 2,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

describe("twenty_activities_list_for", () => {
  it("injects target_type → targetXxxId[eq]:<id> filter and joins both timelines", async () => {
    const calls: FetchCapture[] = [];
    const config = resolveConfig({
      apiKey: "test-key",
      serverUrl: "https://crm.test.local",
      allowedWorkspaceIds: ["ws-1"],
      defaultWorkspaceId: "ws-1",
    });
    const client = new TwentyClient(config, silentLogger, {
      fetchImpl: multiFakeFetch(calls),
    });

    const tool = buildActivitiesTools(client).find(
      (t) => t.name === "twenty_activities_list_for",
    );
    assert.ok(tool, "twenty_activities_list_for must be registered");

    const result = await tool.execute("call-1", {
      target_type: "Person",
      target_id: "person-uuid-42",
    });

    assert.equal(
      result.details?.status,
      "ok",
      `expected ok, got ${JSON.stringify(result.details)}`,
    );

    // Two parallel calls — order is not guaranteed.
    assert.equal(calls.length, 2);
    const noteCall = calls.find((c) => c.url.includes("/noteTargets"));
    const taskCall = calls.find((c) => c.url.includes("/taskTargets"));
    assert.ok(noteCall, "expected a /noteTargets call");
    assert.ok(taskCall, "expected a /taskTargets call");

    const noteUrl = new URL(noteCall.url);
    assert.equal(
      noteUrl.searchParams.get("filter"),
      "targetPersonId[eq]:person-uuid-42",
    );
    assert.equal(noteUrl.searchParams.get("depth"), "1");

    const taskUrl = new URL(taskCall.url);
    assert.equal(
      taskUrl.searchParams.get("filter"),
      "targetPersonId[eq]:person-uuid-42",
    );
    assert.equal(taskUrl.searchParams.get("depth"), "1");

    const payload = result.details?.data as {
      target: { type: string; id: string };
      notes: { noteId: string | null }[];
      tasks: { taskId: string | null }[];
      counts: { notes: number; tasks: number };
    };
    assert.equal(payload.target.type, "Person");
    assert.equal(payload.target.id, "person-uuid-42");
    assert.equal(payload.counts.notes, 1);
    assert.equal(payload.counts.tasks, 2);
    assert.equal(payload.notes[0]!.noteId, "n-1");
    assert.equal(payload.tasks[1]!.taskId, "t-2");
  });

  it("maps Company target_type to targetCompanyId", async () => {
    const calls: FetchCapture[] = [];
    const config = resolveConfig({
      apiKey: "test-key",
      serverUrl: "https://crm.test.local",
      allowedWorkspaceIds: ["ws-1"],
      defaultWorkspaceId: "ws-1",
    });
    const client = new TwentyClient(config, silentLogger, {
      fetchImpl: multiFakeFetch(calls),
    });

    const tool = buildActivitiesTools(client).find(
      (t) => t.name === "twenty_activities_list_for",
    );
    assert.ok(tool);

    await tool.execute("call-2", {
      target_type: "Company",
      target_id: "co-99",
    });

    const noteCall = calls.find((c) => c.url.includes("/noteTargets"));
    assert.ok(noteCall);
    const filter = new URL(noteCall.url).searchParams.get("filter");
    assert.equal(filter, "targetCompanyId[eq]:co-99");
  });
});
