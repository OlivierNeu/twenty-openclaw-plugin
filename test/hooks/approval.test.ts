// Tests for the approval hook.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createApprovalHook } from "../../src/hooks/approval.js";
import { resolveConfig } from "../../src/config.js";

const SILENT_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("approval hook", () => {
  it("returns undefined for read tools NOT in approvalRequired", () => {
    const config = resolveConfig({ apiKey: "k", serverUrl: "https://crm.test.local" });
    const handler = createApprovalHook(config, SILENT_LOGGER);

    const result = handler({
      toolName: "twenty_people_list",
      params: { limit: 10 },
    });
    assert.equal(result, undefined);
  });

  it("returns requireApproval (severity=critical, deny on timeout) for default destructive tools", () => {
    const config = resolveConfig({ apiKey: "k", serverUrl: "https://crm.test.local" });
    const handler = createApprovalHook(config, SILENT_LOGGER);

    const result = handler({
      toolName: "twenty_people_delete",
      params: { id: "person-uuid-42" },
    });

    assert.ok(result);
    assert.ok(result!.requireApproval);
    const ra = result!.requireApproval!;
    assert.equal(ra.severity, "critical");
    assert.equal(ra.timeoutBehavior, "deny");
    assert.equal(ra.timeoutMs, 600_000);
    assert.ok(ra.title.includes("twenty_people_delete"));
    assert.ok(
      ra.description.includes("person-uuid-42"),
      "the approval prompt should surface the target id back to the operator",
    );
  });

  it("strips workspaceId from the parameter preview", () => {
    const config = resolveConfig({
      apiKey: "k", serverUrl: "https://crm.test.local",
      allowedWorkspaceIds: ["ws-1"],
      defaultWorkspaceId: "ws-1",
    });
    const handler = createApprovalHook(config, SILENT_LOGGER);

    const result = handler({
      toolName: "twenty_companies_delete",
      params: { workspaceId: "ws-1", id: "co-42" },
    });

    assert.ok(result?.requireApproval);
    assert.ok(result!.requireApproval!.description.includes("co-42"));
    assert.ok(
      !result!.requireApproval!.description.includes('"workspaceId"'),
      "workspaceId should be stripped from the operator-visible preview",
    );
  });

  it("respects custom approvalRequired list (empty disables gating)", () => {
    const config = resolveConfig({ apiKey: "k", serverUrl: "https://crm.test.local", approvalRequired: [] });
    const handler = createApprovalHook(config, SILENT_LOGGER);

    const result = handler({
      toolName: "twenty_people_delete",
      params: { id: "p-1" },
    });
    assert.equal(result, undefined);
  });

  it("returns undefined when the plugin is disabled", () => {
    const config = resolveConfig({ apiKey: "k", serverUrl: "https://crm.test.local", enabled: false });
    const handler = createApprovalHook(config, SILENT_LOGGER);

    const result = handler({
      toolName: "twenty_people_delete",
      params: {},
    });
    assert.equal(result, undefined);
  });

  it("never sets pluginId — runner injects it", () => {
    const config = resolveConfig({ apiKey: "k", serverUrl: "https://crm.test.local" });
    const handler = createApprovalHook(config, SILENT_LOGGER);

    const result = handler({
      toolName: "twenty_people_delete",
      params: {},
    });
    assert.ok(result?.requireApproval);
    assert.equal(
      (result!.requireApproval as { pluginId?: string }).pluginId,
      undefined,
    );
  });
});
