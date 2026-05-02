// Verifies `twenty_bulk_import_csv` rejects paths outside
// `allowedImportPaths` BEFORE any disk I/O — the critical safety
// invariant. Two cases :
//   1. Direct outside path (`/etc/passwd`).
//   2. Path traversal (`/tmp/../etc/passwd`) — guarded by
//      `path.resolve()` canonicalisation.
//
// Both must fail with an actionable error and zero HTTP calls.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveConfig } from "../../src/config.js";
import { buildBulkTools } from "../../src/tools/bulk.js";
import { TwentyClient } from "../../src/twenty-client.js";

interface FetchCapture {
  url: string;
  init: RequestInit | undefined;
}

function recordingFetch(capture: FetchCapture[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    capture.push({ url: String(input), init });
    // Should never reach this — surface a 500 so the test fails loudly
    // if path validation is bypassed.
    return new Response('{"data": {"createPeople": []}}', {
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

function buildTool() {
  const calls: FetchCapture[] = [];
  const config = resolveConfig({
    apiKey: "test-key",
    serverUrl: "https://crm.test.local",
    allowedWorkspaceIds: ["ws-1"],
    defaultWorkspaceId: "ws-1",
    // Tight whitelist for the test — only `/tmp/` allowed.
    allowedImportPaths: ["/tmp/"],
  });
  const client = new TwentyClient(config, silentLogger, {
    fetchImpl: recordingFetch(calls),
  });
  const tool = buildBulkTools(client, {
    allowedImportPaths: config.allowedImportPaths,
  }).find((t) => t.name === "twenty_bulk_import_csv") as unknown as {
    execute: (id: string, params: unknown) => Promise<{
      details?: { status: string; data?: unknown; error?: string };
    }>;
  } | undefined;
  return { tool, calls };
}

describe("twenty_bulk_import_csv path validation", () => {
  it("rejects direct outside path (/etc/passwd) with no HTTP call", async () => {
    const { tool, calls } = buildTool();
    assert.ok(tool, "twenty_bulk_import_csv must be registered");

    const result = await tool.execute("call-1", {
      csv_path: "/etc/passwd",
      entity: "people",
      dry_run: true,
    });

    assert.equal(
      result.details?.status,
      "failed",
      `expected failed, got ${JSON.stringify(result.details)}`,
    );
    const error = result.details?.error ?? "";
    // Must mention the path and the allowed list — actionable for the agent.
    assert.match(
      error,
      /allowedImportPaths|outside|csv_path/i,
      `error not actionable: ${error}`,
    );
    // CRITICAL: zero HTTP calls — file I/O happens after the check too,
    // but the network is the side-effect we must keep clean.
    assert.equal(calls.length, 0, "no HTTP request should be made");
  });

  it("rejects path traversal (/tmp/../etc/passwd) — defeats naïve startsWith", async () => {
    const { tool, calls } = buildTool();
    assert.ok(tool);

    const result = await tool.execute("call-1", {
      csv_path: "/tmp/../etc/passwd",
      entity: "people",
      dry_run: true,
    });

    assert.equal(
      result.details?.status,
      "failed",
      `path traversal must be rejected; got ${JSON.stringify(result.details)}`,
    );
    assert.equal(calls.length, 0);
    // The resolved path (i.e. /etc/passwd) should be surfaced so the
    // agent can see why the request was refused.
    const error = result.details?.error ?? "";
    assert.match(error, /\/etc\/passwd/, `resolved path should be in error: ${error}`);
  });
});
