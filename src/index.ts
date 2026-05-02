// twenty-openclaw — Twenty CRM REST API plugin for OpenClaw.
//
// P0+P1 bootstrap: exposes a single read-only tool (`twenty_workspace_info`)
// that lists the metadata objects of the configured Twenty workspace.
// Future phases (P2-P4) will add ~30 domain tools spanning People,
// Companies, Opportunities, Notes, Tasks, plus dedup/bulk helpers.
//
// Security model:
//   1. Workspace whitelist — every call is checked against
//      `allowedWorkspaceIds` before any HTTP request goes out. Calls to
//      workspaces outside the list throw {@link TwentyWorkspaceNotAllowedError}
//      and surface as a tool failure to the model.
//   2. Approval gating (P3, NOT in this bootstrap) — destructive ops will
//      trigger a `before_tool_call` approval prompt. The `approvalRequired`
//      list is already in the manifest so operators can configure it.
//   3. Global read-only switch — when `readOnly: true`, every mutating
//      tool is rejected at the plugin layer. P0+P1 ships only read-only
//      tools, so the flag is a no-op for now but plumbed end-to-end.
//   4. No secret in code — `apiKey` comes from the plugin config (with
//      `${ENV_VAR}` substitution), never from the LLM's parameter space.

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

import { resolveConfig } from "./config.js";
import { buildWorkspaceTools } from "./tools/workspace.js";
import { TwentyClient } from "./twenty-client.js";
import type { TwentyPluginConfig } from "./types.js";

// Re-export helpers so tests can pull them without re-importing every
// submodule, and so downstream packagers can depend on internals if they
// need to (e.g. for an inspector tool).
export { resolveConfig, resolveEnv } from "./config.js";
export {
  TwentyClient,
  TwentyApiError,
  TwentyReadOnlyError,
  TwentyWorkspaceNotAllowedError,
} from "./twenty-client.js";
export type {
  ResolvedTwentyConfig,
  TwentyPluginConfig,
  TwentyRequestOptions,
  TwentyMetadataObject,
  TwentyMetadataField,
  TwentyPerson,
  TwentyCompany,
  TwentyOpportunity,
  TwentyNote,
  TwentyTask,
} from "./types.js";

/**
 * Register every Twenty tool against the provided plugin API. Exposed so
 * tests can drive the registration with a fake API surface.
 */
export function registerTwentyPlugin(api: OpenClawPluginApi): void {
  const rawConfig = (api.pluginConfig ?? {}) as TwentyPluginConfig;
  const config = resolveConfig(rawConfig);

  if (!config.enabled) {
    api.logger.warn(
      "twenty-openclaw: disabled via config — no tools registered",
    );
    return;
  }

  if (!config.apiKey) {
    api.logger.warn(
      "twenty-openclaw: apiKey is empty — plugin disabled (set plugins.entries.twenty-openclaw.config.apiKey)",
    );
    return;
  }

  if (config.allowedWorkspaceIds.length === 0) {
    api.logger.warn(
      "twenty-openclaw: allowedWorkspaceIds is empty — every workspace call will be rejected. Add at least one workspace UUID to enable.",
    );
  }

  const client = new TwentyClient(config, api.logger);

  // Order doesn't matter for tools — we group by domain for log clarity.
  // P0+P1: only the workspace tools are registered. Future phases append
  // people, companies, opportunities, notes, tasks, etc.
  const allTools = [
    ...buildWorkspaceTools(client),
  ];

  for (const tool of allTools) {
    // The SDK exposes `registerTool(tool: AnyAgentTool, opts?)`. Our
    // factory output is shape-compatible (name, description, parameters,
    // execute, label) but the precise `AnyAgentTool` type is inferred
    // through several generics; we hand the runtime a structurally
    // compatible object via an `unknown` widen.
    (api.registerTool as (tool: unknown) => void)(tool);
  }

  // Approval gating is intentionally NOT wired in this bootstrap — the
  // `before_tool_call` hook arrives in P3 once the destructive tools
  // exist. The `approvalRequired` list in the manifest is already shaped
  // for that future hook.

  api.logger.info(
    `twenty-openclaw: ready — ${allTools.length} tool(s) registered, ` +
      `${config.approvalRequired.size} approval-gated (P3, not yet enforced), ` +
      `${config.allowedWorkspaceIds.length} allowed workspace(s), ` +
      `readOnly=${config.readOnly}`,
  );
}

export default definePluginEntry({
  id: "twenty-openclaw",
  name: "Twenty",
  description:
    "Twenty CRM REST API plugin for OpenClaw — manage people, companies, opportunities, notes, tasks across one or more Twenty workspaces with workspace_id whitelist and approval gating on destructive ops",
  register(api) {
    registerTwentyPlugin(api);
  },
});
