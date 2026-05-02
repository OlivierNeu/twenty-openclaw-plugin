// Verifies that `twenty_metadata_field_create` forwards the loose
// `type` + opaque `options`/`settings`/`relationCreationPayload` body
// verbatim to Twenty (D1 design — Twenty validates server-side) and
// unwraps `data.createOneField`.
//
// Also verifies `twenty_metadata_fields_list` dispatches to
// `/rest/metadata/objects/{id}` (cheap, scoped) when `objectMetadataId`
// is supplied — Twenty's metadata API does NOT support a query-level
// `?objectMetadataId=` filter, and the `/fields` response does not
// include `objectMetadataId`, so the smarter routing matters.

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

describe("twenty_metadata_field_create", () => {
  it(
    "POSTs to /rest/metadata/fields with the body untouched (loose type + " +
      "opaque options/settings) and unwraps `data.createOneField`",
    async () => {
      const calls: FetchCapture[] = [];
      const client = buildClient(
        {
          data: {
            createOneField: {
              id: "field-1",
              type: "RELATION",
              name: "linkedPerson",
              label: "Linked Person",
            },
          },
        },
        calls,
        201,
      );

      const tool = buildMetadataTools(client).find(
        (t) => t.name === "twenty_metadata_field_create",
      ) as unknown as ToolHandle;
      assert.ok(tool, "twenty_metadata_field_create must be registered");

      // Exercise the RELATION case — the cherry-picked validation that
      // proves the loose schema works end-to-end (cf. P5 design D1).
      const result = await tool.execute("call-1", {
        objectMetadataId: "obj-1",
        type: "RELATION",
        name: "linkedPerson",
        label: "Linked Person",
        settings: {
          relationType: "MANY_TO_ONE",
          onDelete: "SET_NULL",
        },
        relationCreationPayload: {
          targetObjectMetadataId: "obj-person",
          type: "MANY_TO_ONE",
          targetFieldLabel: "Tasks",
          targetFieldIcon: "IconBuildingSkyscraper",
        },
      });

      assert.equal(
        result.details?.status,
        "ok",
        `expected ok, got ${JSON.stringify(result.details)}`,
      );
      const created = result.details?.data as { id: string; type: string };
      assert.equal(created.id, "field-1");
      assert.equal(created.type, "RELATION");

      assert.equal(calls.length, 1);
      const url = new URL(calls[0]!.url);
      assert.equal(url.pathname, "/rest/metadata/fields");
      assert.equal(calls[0]!.init?.method, "POST");

      const body = JSON.parse(calls[0]!.init!.body as string);
      assert.equal(body.objectMetadataId, "obj-1");
      assert.equal(body.type, "RELATION");
      assert.equal(body.name, "linkedPerson");
      assert.equal(body.settings.relationType, "MANY_TO_ONE");
      assert.equal(
        body.relationCreationPayload.targetObjectMetadataId,
        "obj-person",
      );
    },
  );
});

describe("twenty_metadata_fields_list", () => {
  it(
    "with `objectMetadataId` set, GETs /rest/metadata/objects/{id} and " +
      "extracts the inline `fields[]`",
    async () => {
      const calls: FetchCapture[] = [];
      const client = buildClient(
        {
          data: {
            object: {
              id: "obj-7",
              nameSingular: "mission",
              fields: [
                { id: "f-1", name: "name", type: "TEXT" },
                { id: "f-2", name: "createdAt", type: "DATE_TIME" },
              ],
            },
          },
        },
        calls,
      );

      const tool = buildMetadataTools(client).find(
        (t) => t.name === "twenty_metadata_fields_list",
      ) as unknown as ToolHandle;
      assert.ok(tool, "twenty_metadata_fields_list must be registered");

      const result = await tool.execute("call-2", { objectMetadataId: "obj-7" });
      assert.equal(result.details?.status, "ok");
      const payload = result.details?.data as {
        data: { id: string; name: string }[];
        totalCount: number;
        source: string;
      };
      assert.equal(payload.totalCount, 2);
      assert.equal(payload.source, "object");
      assert.equal(payload.data[0]!.name, "name");

      assert.equal(calls.length, 1);
      const url = new URL(calls[0]!.url);
      // CRITICAL — must hit the *object* endpoint, not /fields. The metadata
      // API rejects `?objectMetadataId=` on /fields with a 400.
      assert.equal(url.pathname, "/rest/metadata/objects/obj-7");
      assert.equal(url.search, "");
      assert.equal(calls[0]!.init?.method, "GET");
    },
  );

  it("without `objectMetadataId`, GETs /rest/metadata/fields", async () => {
    const calls: FetchCapture[] = [];
    const client = buildClient(
      { data: { fields: [{ id: "f-3", name: "nickname" }] } },
      calls,
    );

    const tool = buildMetadataTools(client).find(
      (t) => t.name === "twenty_metadata_fields_list",
    ) as unknown as ToolHandle;
    assert.ok(tool, "twenty_metadata_fields_list must be registered");

    const result = await tool.execute("call-3", {});
    assert.equal(result.details?.status, "ok");
    const payload = result.details?.data as {
      data: unknown[];
      source: string;
    };
    assert.equal(payload.source, "fields");
    assert.equal(payload.data.length, 1);

    assert.equal(calls.length, 1);
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/rest/metadata/fields");
  });
});
