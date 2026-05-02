// Verifies the P5 metadata mutations are gated by the default approval
// list — `*_create`, `*_update`, `*_delete` for both objects and fields
// must trigger `requireApproval` with severity=critical (matching the
// hard-delete semantics confirmed empirically on 2026-05-02).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveConfig } from "../../src/config.js";
import { createApprovalHook } from "../../src/hooks/approval.js";

const SILENT_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const GATED_METADATA_TOOLS = [
  "twenty_metadata_object_create",
  "twenty_metadata_object_update",
  "twenty_metadata_object_delete",
  "twenty_metadata_field_create",
  "twenty_metadata_field_update",
  "twenty_metadata_field_delete",
];

const UNGATED_METADATA_TOOLS = [
  "twenty_metadata_objects_list",
  "twenty_metadata_object_get",
  "twenty_metadata_fields_list",
  "twenty_metadata_field_get",
];

describe("metadata approval gating (default config)", () => {
  it("gates every metadata write tool with severity=critical", () => {
    const config = resolveConfig({ apiKey: "k" });
    const handler = createApprovalHook(config, SILENT_LOGGER);

    for (const toolName of GATED_METADATA_TOOLS) {
      const result = handler({
        toolName,
        params: { id: "meta-42" },
      });
      assert.ok(
        result?.requireApproval,
        `${toolName} should require approval by default`,
      );
      assert.equal(
        result!.requireApproval!.severity,
        "critical",
        `${toolName} should escalate to severity=critical (hard-delete semantics)`,
      );
      assert.equal(result!.requireApproval!.timeoutBehavior, "deny");
    }
  });

  it("does NOT gate metadata read tools", () => {
    const config = resolveConfig({ apiKey: "k" });
    const handler = createApprovalHook(config, SILENT_LOGGER);

    for (const toolName of UNGATED_METADATA_TOOLS) {
      const result = handler({ toolName, params: {} });
      assert.equal(
        result,
        undefined,
        `${toolName} is read-only — must not trigger approval`,
      );
    }
  });

  it(
    "approvalRequired default contains every metadata write tool (manifest " +
      "and config.ts must stay in sync)",
    () => {
      const config = resolveConfig({ apiKey: "k" });
      for (const toolName of GATED_METADATA_TOOLS) {
        assert.ok(
          config.approvalRequired.has(toolName),
          `default approvalRequired must include ${toolName}`,
        );
      }
    },
  );
});
