// Type definitions for the twenty-openclaw plugin.
//
// Kept separate from the entry point so that tools, hooks, and the HTTP
// client can import them without pulling in the full plugin registration
// code.

export type TwentyLogLevel = "debug" | "info" | "warn" | "error";

/**
 * Runtime configuration as it appears in
 * `plugins.entries.twenty-openclaw.config`. All fields are optional —
 * defaults are applied in {@link resolveConfig}.
 */
export interface TwentyPluginConfig {
  enabled?: boolean;
  apiKey?: string;
  serverUrl?: string;
  allowedWorkspaceIds?: string[];
  defaultWorkspaceId?: string;
  approvalRequired?: string[];
  readOnly?: boolean;
  logLevel?: TwentyLogLevel;
  allowedImportPaths?: string[];
}

/**
 * Fully resolved plugin configuration after defaults and env substitution.
 *
 * Invariant: when `defaultWorkspaceId` is non-empty, it MUST be a member
 * of `allowedWorkspaceIds`. {@link resolveConfig} enforces this.
 */
export interface ResolvedTwentyConfig {
  enabled: boolean;
  apiKey: string;
  serverUrl: string;
  allowedWorkspaceIds: string[];
  defaultWorkspaceId: string;
  approvalRequired: Set<string>;
  readOnly: boolean;
  logLevel: TwentyLogLevel;
  allowedImportPaths: string[];
}

/**
 * Options for a single Twenty REST request through {@link TwentyClient.request}.
 *
 * - `workspaceId` overrides the default workspace for this call. Must be
 *   present in `allowedWorkspaceIds`, otherwise the request is rejected
 *   before any network round trip.
 * - `query` is appended as URL search params after dropping `undefined`
 *   values. Twenty pagination uses cursor-based fields (`startingAfter`,
 *   `endingBefore`, `limit`) which callers pass through here.
 * - `body` is JSON-encoded automatically.
 * - `signal` is forwarded to `fetch` for cancellation.
 */
export interface TwentyRequestOptions {
  workspaceId?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Plugin logger surface — structurally compatible with `PluginLogger` from
 * the SDK. `debug` is optional because the SDK's contract makes it
 * optional too; helpers should guard with `logger.debug?.(...)`.
 */
export interface TwentyLogger {
  debug?: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Twenty domain types — minimal shapes for P0+P1.
//
// Only the fields actually consumed by the workspace-info tool are typed
// here. Domain-specific tools (people, companies, ...) will extend these
// in later phases. We keep them exported so external callers (and future
// tests) can rely on stable names.
// ---------------------------------------------------------------------------

/**
 * Shape of a Twenty workspace metadata object as returned by
 * `GET /rest/metadata/objects`. Twenty's response wrapping has shifted
 * across versions, so the fields here are intentionally permissive.
 */
export interface TwentyMetadataObject {
  id?: string;
  nameSingular?: string;
  namePlural?: string;
  labelSingular?: string;
  labelPlural?: string;
  description?: string;
  isCustom?: boolean;
  isActive?: boolean;
  isSystem?: boolean;
  fields?: TwentyMetadataField[];
  [key: string]: unknown;
}

export interface TwentyMetadataField {
  id?: string;
  name?: string;
  label?: string;
  type?: string;
  isCustom?: boolean;
  isActive?: boolean;
  [key: string]: unknown;
}

/**
 * Minimal placeholders for the standard objects Twenty exposes. Future
 * domain tools will narrow these to the exact shape they query.
 */
export interface TwentyPerson {
  id: string;
  name?: { firstName?: string; lastName?: string };
  emails?: { primaryEmail?: string };
  [key: string]: unknown;
}

export interface TwentyCompany {
  id: string;
  name?: string;
  domainName?: { primaryLinkUrl?: string };
  [key: string]: unknown;
}

export interface TwentyOpportunity {
  id: string;
  name?: string;
  amount?: { amountMicros?: number; currencyCode?: string };
  stage?: string;
  [key: string]: unknown;
}

export interface TwentyNote {
  id: string;
  title?: string;
  bodyV2?: { markdown?: string; blocknote?: string };
  [key: string]: unknown;
}

export interface TwentyTask {
  id: string;
  title?: string;
  status?: string;
  dueAt?: string;
  [key: string]: unknown;
}
