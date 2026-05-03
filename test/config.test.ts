// Trivial sanity check on the config resolver.
//
// Goal: keep the typecheck + test loop wired end-to-end so future PRs
// can extend the suite without reinventing the harness. Real coverage
// lands with the P2 domain tools.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveConfig, resolveEnv } from "../src/config.js";

describe("resolveConfig", () => {
  it("applies defaults when given an empty config", () => {
    const cfg = resolveConfig({});
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.apiKey, "");
    assert.equal(cfg.serverUrl, "https://crm.lacneu.com");
    assert.deepEqual(cfg.allowedWorkspaceIds, []);
    assert.equal(cfg.defaultWorkspaceId, "");
    assert.equal(cfg.readOnly, false);
    assert.equal(cfg.logLevel, "info");
    // Default approval list covers every destructive tool:
    //   8  P2-P4 ops (people/companies/opportunities/notes/tasks delete +
    //                 dedup_auto_merge + bulk_import_csv + bulk_delete)
    //   6  P5 metadata mutations (object/field × create/update/delete)
    //   1  P6 generic record dispatch (record_delete)
    //   4  P7 dashboards (dashboard/tab/widget delete + replace_layout)
    //   5  P8 workflows (workflow_delete + version × activate/deactivate/
    //                    delete + workflow_run)
    //   = 24.
    // Must stay aligned with `DEFAULT_APPROVAL_REQUIRED` in src/config.ts
    // and `configSchema.properties.approvalRequired.default` in
    // openclaw.plugin.json.
    assert.equal(cfg.approvalRequired.size, 24);
  });

  it("strips a trailing slash from serverUrl", () => {
    const cfg = resolveConfig({ serverUrl: "https://crm.example.com/" });
    assert.equal(cfg.serverUrl, "https://crm.example.com");
  });

  it("falls back to the first allowed workspace as default", () => {
    const cfg = resolveConfig({
      allowedWorkspaceIds: ["ws-a", "ws-b"],
    });
    assert.equal(cfg.defaultWorkspaceId, "ws-a");
  });

  it("rejects a defaultWorkspaceId outside allowedWorkspaceIds", () => {
    assert.throws(
      () =>
        resolveConfig({
          allowedWorkspaceIds: ["ws-a"],
          defaultWorkspaceId: "ws-rogue",
        }),
      /not present in allowedWorkspaceIds/,
    );
  });
});

describe("resolveEnv", () => {
  it("expands ${VAR} patterns from process.env", () => {
    process.env.TWENTY_TEST_VAR = "expanded-value";
    assert.equal(
      resolveEnv("prefix/${TWENTY_TEST_VAR}/suffix"),
      "prefix/expanded-value/suffix",
    );
    delete process.env.TWENTY_TEST_VAR;
  });

  it("returns non-string values unchanged", () => {
    assert.equal(resolveEnv(42 as unknown as string), 42 as unknown);
    assert.equal(resolveEnv(undefined as unknown as string), undefined);
  });
});
