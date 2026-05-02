# Changelog

All notable changes to `@lacneu/twenty-openclaw` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial bootstrap (P0 + P1):
  - Plugin scaffolding aligned with the `wix-openclaw` reference
    (`package.json`, `openclaw.plugin.json`, `tsconfig.*`, GitHub Actions
    CI + Release workflows, `.env.smoketest` template).
  - `TwentyClient` HTTP wrapper with `Authorization: Bearer <apiKey>`
    auth, retry on 429/5xx with `Retry-After` honoring, workspace
    whitelist enforcement, and stub OTEL-style spans via debug logs.
  - `resolveConfig` with `${ENV_VAR}` substitution, defaults, and
    `defaultWorkspaceId ∈ allowedWorkspaceIds` invariant check.
  - Tool factory (`defineTwentyTool`) shared across future tools, with
    error mapping for `TwentyApiError`, `TwentyWorkspaceNotAllowedError`,
    and `TwentyReadOnlyError`, plus a `mutates` flag for the global
    read-only switch.
  - First tool: `twenty_workspace_info` (read-only, no parameters,
    `GET /rest/metadata/objects`) — returns workspace URL, object
    counts, and a per-object summary.
  - Smoke test script (`scripts/smoke-test.mjs`) driving the single tool
    against a live Twenty server.
  - README skeleton, CHANGELOG, MIT LICENSE, and `.gitignore` excluding
    `node_modules/`, `dist/`, and secrets.

### Not yet implemented

- The remaining ~29 domain tools (people, companies, opportunities,
  notes, tasks, activities, helpers — P2).
- Approval hook on `before_tool_call` for destructive operations — P3.
- Bulk and dedup helpers (`twenty_bulk_*`, `twenty_dedup_*`,
  `twenty_find_similar`, `twenty_enrich`) — P4.
- Real OTEL tracing through the OpenClaw runtime tracer — pending SDK
  exposure.
