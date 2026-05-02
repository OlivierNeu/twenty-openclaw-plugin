// `before_tool_call` hook for destructive Twenty operations.
//
// Reads the `approvalRequired` set from resolved config and, when a tool
// matches, returns a `requireApproval` directive. The OpenClaw runtime
// surfaces this to the operator (Telegram inline button, Control UI, ...)
// before the tool call proceeds. The hook itself NEVER throws — refusal
// is handled by the runtime when the operator denies the prompt (or the
// timeout elapses with `timeoutBehavior: "deny"`).
//
// Notes on the SDK contract (see
// `node_modules/openclaw/dist/plugin-sdk/src/plugins/types.d.ts`):
//   - `severity` accepts `"info" | "warning" | "critical"` (NOT `"high"`).
//   - `timeoutBehavior` accepts `"allow" | "deny"`.
//   - `pluginId` is set automatically by the hook runner — do not set it
//     yourself.
//
// `before_tool_call` does NOT require the
// `plugins.entries.<id>.hooks.allowConversationAccess` toggle: that policy
// only applies to `llm_input` / `llm_output` / `agent_end`. The wix-openclaw
// plugin uses the same approval pattern with no `allowConversationAccess`
// declaration on either side.

import type { ResolvedTwentyConfig, TwentyLogger } from "../types.js";

/**
 * Shape of a `before_tool_call` event payload — only the fields we use.
 * Mirrors `PluginHookBeforeToolCallEvent` from the SDK.
 */
export interface BeforeToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
}

/**
 * Subset of the SDK's `PluginHookBeforeToolCallResult` that we produce.
 */
export interface BeforeToolCallResult {
  requireApproval?: {
    title: string;
    description: string;
    severity?: "info" | "warning" | "critical";
    timeoutMs?: number;
    timeoutBehavior?: "allow" | "deny";
  };
}

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes
const PARAM_PREVIEW_CHARS = 600;

/**
 * Per-tool extra context surfaced in the approval prompt. Lets us warn
 * the operator about the specific blast radius of the tool — much more
 * useful than the generic "Tool X is about to run" header.
 *
 * Workflow tools especially benefit from this: `twenty_workflow_run`
 * actually executes the workflow (sends emails, makes HTTP calls, etc.),
 * and the operator deserves to see that explicitly.
 */
const TOOL_CONTEXT: Record<string, string> = {
  twenty_workflow_run:
    "**WARNING: this RUNS THE WORKFLOW** — every step with side effects " +
    "(SEND_EMAIL, HTTP_REQUEST, CREATE_RECORD, DELETE_RECORD, …) is " +
    "executed for real. To preview what the workflow will do, deny this " +
    "and call `twenty_workflow_get` first to inspect the flow.",
  twenty_workflow_version_activate:
    "**This puts the version in PRODUCTION**. DATABASE_EVENT and CRON " +
    "triggers will fire automatically on matching events / schedule. Make " +
    "sure the steps are configured correctly before activating.",
  twenty_workflow_version_deactivate:
    "**This stops the version**. Any in-flight runs continue, but new " +
    "automated triggers won't fire. Use `twenty_workflow_run_stop` to " +
    "stop in-flight runs explicitly.",
  twenty_workflow_version_delete:
    "**HARD-delete** of the version (cascades to its WorkflowRuns). " +
    "Irreversible. Prefer `twenty_workflow_version_archive` for cleanup " +
    "without losing history.",
  twenty_workflow_delete:
    "**HARD-delete** of the workflow + every version + every run. " +
    "Irreversible.",
  twenty_dashboard_replace_layout:
    "Atomic replacement of the dashboard layout — anything not in the " +
    "input is destroyed. Tabs and widgets without an `id` are created; " +
    "those with `id` are kept.",
};

/**
 * Truncate the parameter snapshot so we never surface a wall of JSON to
 * the operator. We strip `workspaceId` since it's covered by the config
 * and adds noise to the prompt.
 */
function previewParams(params: Record<string, unknown>): string {
  const { workspaceId: _workspaceId, ...rest } = params; // eslint-disable-line @typescript-eslint/no-unused-vars
  let json: string;
  try {
    json = JSON.stringify(rest, null, 2);
  } catch {
    json = "<unserializable params>";
  }
  if (json.length <= PARAM_PREVIEW_CHARS) return json;
  return `${json.slice(0, PARAM_PREVIEW_CHARS)}…`;
}

/**
 * Build a `before_tool_call` handler bound to a resolved Twenty config.
 * Extracted as a factory so tests can exercise it without a full plugin
 * registration.
 */
export function createApprovalHook(
  config: ResolvedTwentyConfig,
  logger: TwentyLogger,
): (event: BeforeToolCallEvent) => BeforeToolCallResult | undefined {
  return function beforeToolCall(
    event: BeforeToolCallEvent,
  ): BeforeToolCallResult | undefined {
    if (!config.enabled) return undefined;
    if (!config.approvalRequired.has(event.toolName)) return undefined;

    const extraContext = TOOL_CONTEXT[event.toolName];
    const description =
      `Tool \`${event.toolName}\` is about to run with the following parameters:\n\n` +
      "```json\n" +
      previewParams(event.params) +
      "\n```\n\n" +
      (extraContext ? `${extraContext}\n\n` : "") +
      "Approve to execute, deny to cancel. The call will deny automatically " +
      "if no decision is made within 10 minutes.";

    if (config.logLevel === "debug") {
      logger.debug?.(
        `twenty: requesting approval for ${event.toolName} (runId=${event.runId ?? "?"})`,
      );
    }

    return {
      requireApproval: {
        title: `Twenty: confirm ${event.toolName}`,
        description,
        severity: "critical",
        timeoutMs: DEFAULT_TIMEOUT_MS,
        timeoutBehavior: "deny",
      },
    };
  };
}
