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

    const description =
      `Tool \`${event.toolName}\` is about to run with the following parameters:\n\n` +
      "```json\n" +
      previewParams(event.params) +
      "\n```\n\n" +
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
