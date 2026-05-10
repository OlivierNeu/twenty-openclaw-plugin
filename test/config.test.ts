// Trivial sanity check on the config resolver.
//
// Goal: keep the typecheck + test loop wired end-to-end so future PRs
// can extend the suite without reinventing the harness. Real coverage
// lands with the P2 domain tools.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveConfig, resolveEnv } from "../src/config.js";

describe("resolveConfig", () => {
  it("applies defaults when given a minimal config (serverUrl only)", () => {
    const cfg = resolveConfig({ serverUrl: "https://crm.test.local" });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.apiKey, "");
    assert.equal(cfg.serverUrl, "https://crm.test.local");
    assert.deepEqual(cfg.allowedWorkspaceIds, []);
    assert.equal(cfg.defaultWorkspaceId, "");
    assert.equal(cfg.readOnly, false);
    assert.equal(cfg.logLevel, "info");
    // Default approval list covers every destructive tool:
    //   8  P2-P4 ops (people/companies/opportunities/notes/tasks delete +
    //                 dedup_auto_merge + bulk_import_csv + bulk_delete)
    //   6  P5 metadata mutations (object/field × create/update/delete)
    //   1  P6 generic record dispatch (record_delete)
    //   5  P8 workflows (workflow_delete + version × activate/deactivate/
    //                    delete + workflow_run)
    //   7  v0.8.0 PR1 Views (view_destroy + 6 child destroys:
    //       view_field_destroy, view_field_group_destroy,
    //       view_filter_destroy, view_filter_group_destroy,
    //       view_sort_destroy, view_group_destroy)
    //   1  v0.8.0 PR2 List columns (list_columns_reset_default)
    //   7  v0.8.0 PR3 Page layouts (page_layout × destroy/
    //       reset_to_default/replace_with_tabs + tab × destroy/
    //       reset_to_default + widget × destroy/reset_to_default)
    //   5  v0.8.0 PR4 Field config (every field-level wrapper is gated
    //       because metadata mutations affect every record)
    //  11  v0.8.0 PR5 Roles & Permissions (every write — create/update/
    //       delete + 4 assignments + 4 upserts)
    //   1  v0.8.0 PR6 Workspace settings (run_migration; updateWorkspace
    //       was scoped out — Twenty 2.1 requires user context for it)
    //   = 52.
    // Must stay aligned with `DEFAULT_APPROVAL_REQUIRED` in src/config.ts
    // and `configSchema.properties.approvalRequired.default` in
    // openclaw.plugin.json.
    assert.equal(cfg.approvalRequired.size, 52);
  });

  it("throws when serverUrl is missing (no default since v0.8.0)", () => {
    assert.throws(() => resolveConfig({}), /serverUrl.*required/);
  });

  it("throws when serverUrl resolves to empty after env substitution", () => {
    delete process.env.TWENTY_TEST_MISSING_SERVER_URL;
    assert.throws(
      () =>
        resolveConfig({ serverUrl: "${TWENTY_TEST_MISSING_SERVER_URL}" }),
      /serverUrl.*required/,
    );
  });

  it("strips a trailing slash from serverUrl", () => {
    const cfg = resolveConfig({ serverUrl: "https://crm.example.com/" });
    assert.equal(cfg.serverUrl, "https://crm.example.com");
  });

  it("falls back to the first allowed workspace as default", () => {
    const cfg = resolveConfig({
      serverUrl: "https://crm.test.local",
      allowedWorkspaceIds: ["ws-a", "ws-b"],
    });
    assert.equal(cfg.defaultWorkspaceId, "ws-a");
  });

  it("rejects a defaultWorkspaceId outside allowedWorkspaceIds", () => {
    assert.throws(
      () =>
        resolveConfig({
          serverUrl: "https://crm.test.local",
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
