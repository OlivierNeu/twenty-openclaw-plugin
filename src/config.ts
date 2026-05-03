// Plugin configuration helpers.
//
// These helpers are the only place that touches `process.env`, keeping the
// rest of the plugin easy to test with deterministic values.

import type {
  ResolvedTwentyConfig,
  TwentyLogLevel,
  TwentyPluginConfig,
} from "./types.js";

/**
 * Expand `${VAR_NAME}` patterns in a config string against `process.env`.
 * Non-string values are returned untouched so the helper can be used on any
 * raw config field without type narrowing at the call site. Missing env vars
 * become empty strings to avoid leaking `undefined` into downstream code.
 */
export function resolveEnv<T>(value: T): T {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{(\w+)\}/g, (_, name: string) => {
    return process.env[name] ?? "";
  }) as unknown as T;
}

const DEFAULT_SERVER_URL = "https://crm.lacneu.com";

// Must stay byte-aligned with `configSchema.properties.approvalRequired.default`
// in `openclaw.plugin.json`. The manifest is the surface operators see
// (UI hints, validation); this constant is what the runtime actually
// uses when no operator override is present. Drift between the two
// silently leaves destructive tools un-gated — see CHANGELOG 0.7.1.
const DEFAULT_APPROVAL_REQUIRED = [
  "twenty_people_delete",
  "twenty_companies_delete",
  "twenty_opportunities_delete",
  "twenty_notes_delete",
  "twenty_tasks_delete",
  "twenty_dedup_auto_merge",
  "twenty_bulk_import_csv",
  "twenty_bulk_delete",
  // P5 — metadata mutations (custom objects + fields). All hard-delete
  // semantically; create/update gated to keep the workspace schema under
  // operator control.
  "twenty_metadata_object_create",
  "twenty_metadata_object_update",
  "twenty_metadata_object_delete",
  "twenty_metadata_field_create",
  "twenty_metadata_field_update",
  "twenty_metadata_field_delete",
  // P6 — generic record dispatch. Only delete is gated; create/update
  // mirror the per-entity precedent (ungated by default).
  "twenty_record_delete",
  // P7 — dashboards. Gated entries are the irreversible destructions;
  // construction tools (*_add, *_update, create_complete, duplicate)
  // are left ungated so the LLM can iterate on layouts without friction.
  "twenty_dashboard_delete",
  "twenty_dashboard_tab_delete",
  "twenty_dashboard_widget_delete",
  "twenty_dashboard_replace_layout",
  // P8 — workflows. Gates the irreversible destructions plus state
  // transitions that have user-visible side effects (activation flips
  // a workflow into the live trigger registry; run launches an actual
  // execution against workspace data).
  "twenty_workflow_delete",
  "twenty_workflow_version_activate",
  "twenty_workflow_version_deactivate",
  "twenty_workflow_version_delete",
  "twenty_workflow_run",
];

/**
 * Default directories the bulk-import CSV tool is allowed to read from.
 * Restricted to the OpenClaw workspace mount and `/tmp/` (transient
 * scratch). Operators can override the list via
 * `plugins.entries.twenty-openclaw.config.allowedImportPaths`.
 */
const DEFAULT_ALLOWED_IMPORT_PATHS = ["/home/node/.openclaw/", "/tmp/"];

const VALID_LOG_LEVELS: TwentyLogLevel[] = ["debug", "info", "warn", "error"];

/**
 * Strip a single trailing slash from a URL so `${serverUrl}/path` never
 * produces double slashes. Empty strings pass through unchanged.
 */
function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Apply defaults and env substitution to the raw plugin config.
 *
 * - `enabled` is true unless explicitly set to `false`.
 * - `serverUrl` defaults to {@link DEFAULT_SERVER_URL}; trailing slash is
 *   stripped so request paths can be concatenated safely.
 * - `defaultWorkspaceId`, when blank, falls back to the first
 *   `allowedWorkspaceIds` entry. This keeps single-workspace setups (the
 *   typical case) one field shorter.
 * - When `defaultWorkspaceId` is set explicitly, it MUST be a member of
 *   `allowedWorkspaceIds`. Mismatches throw to prevent the plugin from
 *   silently routing every call to a workspace that the operator never
 *   approved.
 * - `approvalRequired` defaults to every destructive operation; pass an
 *   empty array to disable gating entirely.
 * - `readOnly` is false unless explicitly set to `true`.
 */
export function resolveConfig(
  cfg: TwentyPluginConfig = {},
): ResolvedTwentyConfig {
  const apiKey = resolveEnv(cfg.apiKey ?? "");
  const serverUrl = stripTrailingSlash(
    resolveEnv(cfg.serverUrl ?? DEFAULT_SERVER_URL),
  );
  const allowedWorkspaceIds = (cfg.allowedWorkspaceIds ?? []).map((id) =>
    resolveEnv(id),
  );
  const explicitDefault = resolveEnv(cfg.defaultWorkspaceId ?? "");
  const defaultWorkspaceId =
    explicitDefault || (allowedWorkspaceIds[0] ?? "");

  if (
    defaultWorkspaceId &&
    allowedWorkspaceIds.length > 0 &&
    !allowedWorkspaceIds.includes(defaultWorkspaceId)
  ) {
    throw new Error(
      `twenty-openclaw: defaultWorkspaceId "${defaultWorkspaceId}" is not ` +
        `present in allowedWorkspaceIds (${allowedWorkspaceIds.join(", ")}). ` +
        `Add it to the whitelist or pick another default.`,
    );
  }

  const approvalRequired = cfg.approvalRequired ?? DEFAULT_APPROVAL_REQUIRED;

  const logLevel: TwentyLogLevel = VALID_LOG_LEVELS.includes(
    cfg.logLevel as TwentyLogLevel,
  )
    ? (cfg.logLevel as TwentyLogLevel)
    : "info";

  // `allowedImportPaths`: when the operator sets an explicit array, we
  // honour it verbatim (after env substitution and trimming). When the
  // field is missing we fall back to the safe default. An EXPLICIT empty
  // array means "no path is allowed" — the bulk-import tool will refuse
  // every call. We do not merge defaults into operator-provided lists to
  // keep the security surface predictable.
  const allowedImportPaths = (
    Array.isArray(cfg.allowedImportPaths)
      ? cfg.allowedImportPaths
      : DEFAULT_ALLOWED_IMPORT_PATHS
  )
    .map((p) => resolveEnv(p))
    .filter((p) => typeof p === "string" && p.trim() !== "");

  return {
    enabled: cfg.enabled !== false,
    apiKey,
    serverUrl,
    allowedWorkspaceIds,
    defaultWorkspaceId,
    approvalRequired: new Set(approvalRequired),
    readOnly: cfg.readOnly === true,
    logLevel,
    allowedImportPaths,
  };
}
