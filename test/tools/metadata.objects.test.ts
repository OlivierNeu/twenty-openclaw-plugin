// Verifies the metadata objects tools (`twenty_metadata_object_create`,
// `twenty_metadata_object_get`, `twenty_metadata_object_delete`) hit the
// correct paths and unwrap Twenty's `*OneObject` response wrapper keys —
// which differ from the rest of the REST API (`createPerson`, ...). Live
// validation on 2026-05-02 confirmed the wrappers; this test pins them
// against regression.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveConfig } from "../../src/config.js";
import { buildMetadataTools } from "../../src/tools/metadata.js";
import { TwentyClient } from "../../src/twenty-client.js";

interface FetchCapture {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(
  payload: unknown,
  capture: FetchCapture[],
  status = 200,
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

function buildClient(payload: unknown, calls: FetchCapture[], status = 200) {
  const config = resolveConfig({
    apiKey: "test-key",
    serverUrl: "https://crm.test.local",
    allowedWorkspaceIds: ["ws-1"],
    defaultWorkspaceId: "ws-1",
  });
  return new TwentyClient(config, silentLogger, {
    fetchImpl: fakeFetch(payload, calls, status),
  });
}

interface ToolHandle {
  execute: (id: string, params: unknown) => Promise<{
    details?: { status: string; data?: unknown; error?: string };
  }>;
}

describe("twenty_metadata_object_create", () => {
  it("POSTs to /rest/metadata/objects and unwraps `data.createOneObject`", async () => {
    const calls: FetchCapture[] = [];
    const client = buildClient(
      {
        data: {
          createOneObject: {
            id: "obj-1",
            nameSingular: "mission",
            namePlural: "missions",
          },
        },
      },
      calls,
      201,
    );

    const tool = buildMetadataTools(client).find(
      (t) => t.name === "twenty_metadata_object_create",
    ) as unknown as ToolHandle;
    assert.ok(tool, "twenty_metadata_object_create must be registered");

    const result = await tool.execute("call-1", {
      nameSingular: "mission",
      namePlural: "missions",
      labelSingular: "Mission",
      labelPlural: "Missions",
      icon: "IconBriefcase",
    });

    assert.equal(
      result.details?.status,
      "ok",
      `expected ok, got ${JSON.stringify(result.details)}`,
    );
    const created = result.details?.data as {
      id: string;
      nameSingular: string;
    };
    assert.equal(created.id, "obj-1");
    assert.equal(created.nameSingular, "mission");

    assert.equal(calls.length, 1);
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/rest/metadata/objects");
    assert.equal(calls[0]!.init?.method, "POST");
    const body = JSON.parse(calls[0]!.init!.body as string);
    assert.equal(body.nameSingular, "mission");
    assert.equal(body.namePlural, "missions");
    assert.equal(body.icon, "IconBriefcase");
  });
});

describe("twenty_metadata_object_get", () => {
  it("GETs /rest/metadata/objects/{id} and unwraps `data.object`", async () => {
    const calls: FetchCapture[] = [];
    const client = buildClient(
      {
        data: {
          object: {
            id: "obj-9",
            nameSingular: "diagnostic",
            fields: [{ id: "f-1", name: "name" }],
          },
        },
      },
      calls,
    );

    const tool = buildMetadataTools(client).find(
      (t) => t.name === "twenty_metadata_object_get",
    ) as unknown as ToolHandle;
    assert.ok(tool, "twenty_metadata_object_get must be registered");

    const result = await tool.execute("call-2", { id: "obj-9" });
    assert.equal(result.details?.status, "ok");
    const obj = result.details?.data as {
      id: string;
      nameSingular: string;
      fields: { id: string }[];
    };
    assert.equal(obj.id, "obj-9");
    assert.equal(obj.nameSingular, "diagnostic");
    assert.equal(obj.fields.length, 1);

    assert.equal(calls.length, 1);
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/rest/metadata/objects/obj-9");
    assert.equal(calls[0]!.init?.method, "GET");
  });
});

describe("twenty_metadata_object_delete", () => {
  it(
    "DELETEs /rest/metadata/objects/{id} WITHOUT ?soft_delete=true and " +
      "unwraps `data.deleteOneObject`",
    async () => {
      const calls: FetchCapture[] = [];
      const client = buildClient(
        { data: { deleteOneObject: { id: "obj-doomed" } } },
        calls,
      );

      const tool = buildMetadataTools(client).find(
        (t) => t.name === "twenty_metadata_object_delete",
      ) as unknown as ToolHandle;
      assert.ok(tool, "twenty_metadata_object_delete must be registered");

      const result = await tool.execute("call-3", { id: "obj-doomed" });
      assert.equal(result.details?.status, "ok");
      const payload = result.details?.data as { id: string };
      assert.equal(payload.id, "obj-doomed");

      assert.equal(calls.length, 1);
      const url = new URL(calls[0]!.url);
      assert.equal(url.pathname, "/rest/metadata/objects/obj-doomed");
      // CRITICAL — metadata DELETE rejects ?soft_delete=true (the query is
      // parsed as part of the UUID, returning 400). The plugin must NOT
      // emit it on this path.
      assert.equal(
        url.search,
        "",
        "metadata object DELETE must not carry any query string",
      );
      assert.equal(calls[0]!.init?.method, "DELETE");
    },
  );
});
