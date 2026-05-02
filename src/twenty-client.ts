// Twenty REST API HTTP client.
//
// Centralises authentication, workspace whitelist enforcement, retry on
// 429/5xx, and JSON serialisation so individual tools stay thin. Uses
// Node's native `fetch` (Node 22+) — no axios, no node-fetch.
//
// Header conventions (verified against Twenty REST docs):
//   - `Authorization: Bearer <apiKey>`
//   - `Content-Type: application/json` for write requests
//
// Pagination: Twenty exposes cursor-based pagination via the
// `startingAfter`, `endingBefore`, and `limit` query params. The client
// itself is agnostic — callers pass these through `opts.query`.

import type {
  ResolvedTwentyConfig,
  TwentyLogger,
  TwentyRequestOptions,
} from "./types.js";

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;
const INITIAL_BACKOFF_MS = 500;

/**
 * Thrown when the agent passes a `workspaceId` that is not in
 * `config.allowedWorkspaceIds`. The error never reaches the network — the
 * check is performed before `fetch` is called.
 */
export class TwentyWorkspaceNotAllowedError extends Error {
  constructor(workspaceId: string, allowed: string[]) {
    super(
      `Twenty workspace "${workspaceId}" is not in the allowed list ` +
        `(${allowed.length === 0 ? "<empty>" : allowed.join(", ")}). ` +
        `Add it to plugins.entries.twenty-openclaw.config.allowedWorkspaceIds to enable.`,
    );
    this.name = "TwentyWorkspaceNotAllowedError";
  }
}

/**
 * Thrown when a write/delete tool is invoked while `readOnly: true` is
 * set in the plugin config. Surfaced before any HTTP request.
 */
export class TwentyReadOnlyError extends Error {
  constructor(toolName: string) {
    super(
      `twenty-openclaw is in read-only mode — refusing to run "${toolName}". ` +
        `Set plugins.entries.twenty-openclaw.config.readOnly to false to enable writes.`,
    );
    this.name = "TwentyReadOnlyError";
  }
}

/**
 * Thrown for non-retryable HTTP errors (4xx other than 429, plus retried-
 * out 5xx). The message includes the response status and the first 300
 * chars of the body for easier debugging.
 */
export class TwentyApiError extends Error {
  readonly status: number;
  readonly bodyPreview: string;
  constructor(status: number, bodyPreview: string, path: string) {
    super(
      `Twenty API ${status} on ${path}: ${bodyPreview.slice(0, 300)}`,
    );
    this.name = "TwentyApiError";
    this.status = status;
    this.bodyPreview = bodyPreview;
  }
}

/**
 * Sleep for `ms` milliseconds. Extracted for testability.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Convert a record of query values to a URL-encoded search string. Drops
 * `undefined` values and serialises booleans/numbers via `String()`.
 */
function buildQueryString(
  query: Record<string, string | number | boolean | undefined> | undefined,
): string {
  if (!query) return "";
  const entries = Object.entries(query).filter(
    ([, v]) => v !== undefined && v !== null,
  );
  if (entries.length === 0) return "";
  const params = new URLSearchParams();
  for (const [k, v] of entries) {
    params.set(k, String(v));
  }
  return `?${params.toString()}`;
}

/**
 * Authenticated, workspace-aware Twenty REST client.
 *
 * One instance per plugin registration — it captures the resolved config
 * (api key, server url, whitelist) so callers can stay declarative.
 */
export class TwentyClient {
  private readonly config: ResolvedTwentyConfig;
  private readonly logger: TwentyLogger;
  private readonly fetchImpl: typeof fetch;

  constructor(
    config: ResolvedTwentyConfig,
    logger: TwentyLogger,
    options: { fetchImpl?: typeof fetch } = {},
  ) {
    this.config = config;
    this.logger = logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Public read-only access to the configured server URL — useful for tools
   * that need to surface it back to the model (e.g. workspace_info).
   */
  get serverUrl(): string {
    return this.config.serverUrl;
  }

  /**
   * Public read-only access to the configured default workspace id.
   */
  get defaultWorkspaceId(): string {
    return this.config.defaultWorkspaceId;
  }

  /**
   * Public read-only access to the global read-only flag. The tool factory
   * consults this before invoking any tool flagged as `mutates: true`.
   */
  get readOnly(): boolean {
    return this.config.readOnly;
  }

  /**
   * Resolve the effective workspace id for a request and validate it
   * against the whitelist. Throws {@link TwentyWorkspaceNotAllowedError}
   * on mismatch. Returns `null` when neither an explicit nor a default
   * workspace id is configured — Twenty's REST API does not currently
   * require a workspace UUID in the URL (the API key itself is workspace
   * scoped), so the check stays optional.
   */
  resolveWorkspaceId(opts: TwentyRequestOptions): string | null {
    const candidate = opts.workspaceId ?? this.config.defaultWorkspaceId;
    if (!candidate) {
      return null;
    }

    if (!this.config.allowedWorkspaceIds.includes(candidate)) {
      throw new TwentyWorkspaceNotAllowedError(
        candidate,
        this.config.allowedWorkspaceIds,
      );
    }

    return candidate;
  }

  /**
   * Build the headers for a single request. Twenty's REST API expects the
   * API key prefixed with `Bearer ` — this is the key invariant that
   * differs from the (Wix) reference implementation, where the key is sent
   * raw.
   */
  private buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  /**
   * Perform an authenticated request against the Twenty REST API. Retries
   * up to {@link MAX_RETRIES} times on 429/5xx with exponential backoff.
   *
   * Returns the parsed JSON response, or `null` for empty 2xx bodies (e.g.
   * 204 No Content). Throws {@link TwentyApiError} on non-retryable
   * failures and {@link TwentyWorkspaceNotAllowedError} on whitelist
   * violations.
   *
   * Tracing: a stub OTEL-like span is emitted via `logger.debug` with
   * elapsed time. Once the OpenClaw runtime tracer is exposed via
   * `api.runtime`, upgrade this to a real span. See plugin issues for the
   * tracking ticket.
   */
  async request<TResponse = unknown>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    opts: TwentyRequestOptions = {},
  ): Promise<TResponse | null> {
    // Workspace whitelist check — throws before any network call.
    this.resolveWorkspaceId(opts);

    const url =
      this.config.serverUrl + path + buildQueryString(opts.query);

    const headers = this.buildHeaders();
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;

    const spanName = `twenty.${method.toLowerCase()}.${path}`;
    const t0 = Date.now();
    if (this.config.logLevel === "debug") {
      this.logger.debug?.(
        `${spanName} start` +
          (body ? ` body=${body.slice(0, 200)}` : ""),
      );
    }

    let attempt = 0;
    let lastErrorBody = "";
    let lastStatus = 0;

    while (attempt <= MAX_RETRIES) {
      const resp = await this.fetchImpl(url, {
        method,
        headers,
        body,
        signal: opts.signal,
      });

      if (resp.ok) {
        const text = await resp.text();
        const dt = Date.now() - t0;
        if (this.config.logLevel === "debug") {
          this.logger.debug?.(
            `${spanName} end status=${resp.status} ms=${dt}`,
          );
        }
        if (!text) return null;
        try {
          return JSON.parse(text) as TResponse;
        } catch {
          // Twenty sometimes returns text/plain for trivial endpoints —
          // return it raw rather than crashing.
          return text as unknown as TResponse;
        }
      }

      lastStatus = resp.status;
      lastErrorBody = await resp.text();

      if (!RETRY_STATUSES.has(resp.status) || attempt === MAX_RETRIES) {
        const dt = Date.now() - t0;
        if (this.config.logLevel === "debug") {
          this.logger.debug?.(
            `${spanName} end status=${resp.status} ms=${dt} (final)`,
          );
        }
        throw new TwentyApiError(resp.status, lastErrorBody, path);
      }

      // Honour `Retry-After` if present, else exponential backoff.
      const retryAfter = resp.headers.get("retry-after");
      const backoff = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : INITIAL_BACKOFF_MS * Math.pow(2, attempt);

      this.logger.warn(
        `twenty: ${method} ${path} → ${resp.status}, retrying in ${backoff}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(backoff);
      attempt++;
    }

    // Defensive: should be unreachable since the loop either returns or
    // throws on the last attempt.
    throw new TwentyApiError(lastStatus, lastErrorBody, path);
  }
}
