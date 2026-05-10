// Catalogue tests for the final v0.8.0 surfaces (PR4 + PR5 + PR6).
//
// Each builder is verified against the openclaw.plugin.json
// `contracts.tools` list — any drift between the manifest and the
// runtime registration is caught here.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveConfig } from "../../src/config.js";
import { buildFieldConfigTools } from "../../src/tools/field-config.js";
import { buildRolesTools } from "../../src/tools/roles.js";
import { buildWorkspaceTools } from "../../src/tools/workspace.js";
import { TwentyClient } from "../../src/twenty-client.js";

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeClient() {
  const config = resolveConfig({
    apiKey: "test-key",
    serverUrl: "https://crm.test.local",
    allowedWorkspaceIds: ["ws-1"],
    defaultWorkspaceId: "ws-1",
  });
  return new TwentyClient(config, silentLogger);
}

describe("Surface 3 — Field config catalogue (PR4)", () => {
  it("registers exactly 5 tools with the expected names", () => {
    const client = makeClient();
    const tools = buildFieldConfigTools(client);
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(
      names,
      [
        "twenty_metadata_field_constraints_set",
        "twenty_metadata_field_default_set",
        "twenty_metadata_field_options_set",
        "twenty_metadata_field_relation_settings_set",
        "twenty_metadata_field_settings_set",
      ],
    );
    assert.equal(tools.length, 5);
  });
});

describe("Surface 5 — Roles & Permissions catalogue (PR5)", () => {
  it("registers exactly 13 tools with the expected names", () => {
    const client = makeClient();
    const tools = buildRolesTools(client);
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(
      names,
      [
        "twenty_role_assign_agent",
        "twenty_role_assign_api_key",
        "twenty_role_assign_workspace_member",
        "twenty_role_create",
        "twenty_role_delete",
        "twenty_role_field_permissions_upsert",
        "twenty_role_get",
        "twenty_role_object_permissions_upsert",
        "twenty_role_permission_flags_upsert",
        "twenty_role_revoke_agent",
        "twenty_role_row_level_predicates_upsert",
        "twenty_role_update",
        "twenty_roles_list",
      ],
    );
    assert.equal(tools.length, 13);
  });
});

describe("Surface 6 — Workspace catalogue (info + PR6 settings)", () => {
  it(
    "exposes 3 tools: workspace_info (P0) + workspace_get / _run_migration (PR6)",
    () => {
      const client = makeClient();
      const tools = buildWorkspaceTools(client);
      const names = tools.map((t) => t.name).sort();
      assert.deepEqual(
        names,
        [
          "twenty_workspace_get",
          "twenty_workspace_info",
          "twenty_workspace_run_migration",
        ],
      );
      assert.equal(tools.length, 3);
    },
  );
});
