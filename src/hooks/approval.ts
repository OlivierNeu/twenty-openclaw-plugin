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
  twenty_page_layout_replace_with_tabs:
    "Atomic replacement of the page-layout's tab+widget tree — anything " +
    "not in the input is DESTROYED. Tabs and widgets without an `id` are " +
    "created; those with `id` are kept (and updated when fields differ).",
  twenty_page_layout_destroy:
    "**HARD-delete** of the PageLayout (and every tab + widget). " +
    "Irreversible. For DASHBOARD layouts the matching `/rest/dashboards` " +
    "workspace record is also soft-deleted (still restorable via the UI).",
  twenty_page_layout_reset_to_default:
    "Resets the PageLayout (and its tabs + widgets) to Twenty's shipped " +
    "default. Overwrites every tab and widget on the layout.",
  twenty_page_layout_tab_destroy:
    "**HARD-delete** of a tab and every widget it contains. Irreversible.",
  twenty_page_layout_tab_reset_to_default:
    "Resets a tab to Twenty's shipped default — its widgets are " +
    "regenerated from the standard template.",
  twenty_page_layout_widget_destroy:
    "**HARD-delete** of a widget. Irreversible.",
  twenty_page_layout_widget_reset_to_default:
    "Resets a widget to Twenty's shipped default — overwrites its " +
    "current configuration.",
  twenty_view_destroy:
    "**HARD-delete** of the View, including every dependent ViewField, " +
    "ViewFilter, ViewSort, ViewGroup and ViewFieldGroup. Irreversible. " +
    "Prefer twenty_view_delete for reversible removal (sets deletedAt, " +
    "stays restorable through the Twenty UI).",
  twenty_view_field_destroy:
    "**HARD-delete** of a single ViewField. Irreversible. Prefer " +
    "twenty_view_field_delete for reversible removal.",
  twenty_view_field_group_destroy:
    "**HARD-delete** of a ViewFieldGroup (visual block). Irreversible.",
  twenty_view_filter_destroy:
    "**HARD-delete** of a ViewFilter. Irreversible.",
  twenty_view_filter_group_destroy:
    "**HARD-delete** of a ViewFilterGroup (logical AND/OR group). " +
    "Irreversible — child filters become ungrouped.",
  twenty_view_sort_destroy:
    "**HARD-delete** of a ViewSort. Irreversible.",
  twenty_view_group_destroy:
    "**HARD-delete** of a ViewGroup (kanban column). Irreversible.",
  twenty_list_columns_reset_default:
    "Resets the per-column display preferences (size + visibility + " +
    "position) on every column of the target view in one shot. ViewFields " +
    "are NOT destroyed and field metadata is NOT touched, but the current " +
    "layout is overwritten — denying still leaves the view as-is.",
  twenty_metadata_field_options_set:
    "Replaces the option list of a SELECT / MULTI_SELECT field. Options " +
    "missing from the array are REMOVED. Records using a removed option " +
    "may need migration.",
  twenty_metadata_field_settings_set:
    "Replaces the type-specific `settings` JSON of a field. The plugin " +
    "forwards verbatim — Twenty validates server-side. Pre-existing " +
    "settings keys not in the new object are CLEARED.",
  twenty_metadata_field_default_set:
    "Sets (or clears) the default value of a field. New records with no " +
    "value for this field will pick up the new default.",
  twenty_metadata_field_constraints_set:
    "Toggles boolean constraints on a field (isNullable / isUnique / " +
    "isUIReadOnly / isActive). Constraint tightening can fail when " +
    "existing data violates it.",
  twenty_metadata_field_relation_settings_set:
    "Sets onDelete behavior on a RELATION field. CASCADE = delete this " +
    "record when the related record is deleted. Replace-on-update " +
    "semantics — non-relation settings keys are CLEARED.",
  twenty_role_create:
    "Creates a new Role. Every flag toggled here flows through to every " +
    "future assignee.",
  twenty_role_update:
    "Patches a Role's flags / label. Every assignee inherits the change " +
    "immediately.",
  twenty_role_delete:
    "Deletes a Role. Previously-assigned principals fall back to the " +
    "workspace defaultRoleId — denies all access until reassigned.",
  twenty_role_assign_workspace_member:
    "Assigns a Role to a workspace member (human user). Replaces their " +
    "previous role atomically.",
  twenty_role_assign_agent:
    "Assigns a Role to an agent (LLM principal). Agents act on behalf " +
    "of code, not humans — over-permissive role can run unsupervised.",
  twenty_role_revoke_agent:
    "Removes the Role from an agent. The agent falls back to the " +
    "workspace defaultRoleId.",
  twenty_role_assign_api_key:
    "Assigns a Role to an API key. API keys are long-lived credentials " +
    "— the role persists across the key's lifetime.",
  twenty_role_object_permissions_upsert:
    "Upserts object-level permissions on a Role (canRead / canUpdate / " +
    "canSoftDelete / canDestroyObjectRecords for specific objects).",
  twenty_role_field_permissions_upsert:
    "Upserts field-level permissions (canRead / canUpdateFieldValue) on " +
    "a Role for specific fields. Field-level permissions OVERRIDE the " +
    "parent ObjectPermission for those fields.",
  twenty_role_permission_flags_upsert:
    "Replaces the granted PermissionFlag set on a Role. The full array " +
    "REPLACES the previous grants — anything missing is REVOKED.",
  twenty_role_row_level_predicates_upsert:
    "Upserts row-level permission predicates and groups on a Role + " +
    "object pair. Defines which records the role can see / modify via " +
    "an AND/OR predicate tree. Wrong predicates can hide essential " +
    "records or expose PII.",
  twenty_workspace_run_migration:
    "**Apply a workspace migration atomically.** Migrations are " +
    "arbitrarily powerful — they can create, modify, drop objects / " +
    "fields / indexes in one transaction. Irreversible at the schema " +
    "level. Approve only when the action list has been reviewed.",
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
