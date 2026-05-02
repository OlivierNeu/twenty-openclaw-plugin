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
import { createApprovalHook } from "./hooks/approval.js";
import { buildActivitiesTools } from "./tools/activities.js";
import { buildCompaniesTools } from "./tools/companies.js";
import { buildNotesTools } from "./tools/notes.js";
import { buildOpportunitiesTools } from "./tools/opportunities.js";
import { buildPeopleTools } from "./tools/people.js";
import { buildTasksTools } from "./tools/tasks.js";
import { buildWorkspaceTools } from "./tools/workspace.js";
import { TwentyClient } from "./twenty-client.js";
import type { TwentyPluginConfig } from "./types.js";

// Re-export helpers so tests can pull them without re-importing every
// submodule, and so downstream packagers can depend on internals if they
// need to (e.g. for an inspector tool).
export { resolveConfig, resolveEnv } from "./config.js";
export { createApprovalHook } from "./hooks/approval.js";
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
  // P0+P1: workspace introspection (`twenty_workspace_info`).
  // P2: read tools for People, Companies, Opportunities, Notes, Tasks +
  //     a cross-record activities timeline (`twenty_activities_list_for`).
  // Future phases will add create/update/delete (P3) and dedup/bulk
  // helpers (P4); each new domain file just appends to this list.
  const allTools = [
    ...buildWorkspaceTools(client),
    ...buildPeopleTools(client),
    ...buildCompaniesTools(client),
    ...buildOpportunitiesTools(client),
    ...buildNotesTools(client),
    ...buildTasksTools(client),
    ...buildActivitiesTools(client),
  ];

  for (const tool of allTools) {
    // The SDK exposes `registerTool(tool: AnyAgentTool, opts?)`. Our
    // factory output is shape-compatible (name, description, parameters,
    // execute, label) but the precise `AnyAgentTool` type is inferred
    // through several generics; we hand the runtime a structurally
    // compatible object via an `unknown` widen.
    (api.registerTool as (tool: unknown) => void)(tool);
  }

  // P3 — approval gating for destructive tools (`*_delete`, future bulk
  // and merge helpers). The hook returns a `requireApproval` directive;
  // the OpenClaw runtime is responsible for prompting the operator and
  // denying the call when refused or on timeout.
  const approvalHandler = createApprovalHook(config, api.logger);
  // The SDK's `api.on<K>` is strongly typed per hook name; we cast at
  // the boundary so we can keep our handler signature explicit (matches
  // the wix-openclaw precedent).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (api.on as (event: string, handler: any) => void)(
    "before_tool_call",
    approvalHandler,
  );

  api.logger.info(
    `twenty-openclaw: ready — ${allTools.length} tool(s) registered, ` +
      `${config.approvalRequired.size} approval-gated, ` +
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
