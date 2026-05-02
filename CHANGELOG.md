# Changelog

All notable changes to `@lacneu/twenty-openclaw` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-05-02

### Fixed

- **Critical**: P2 list/get tools were hitting Twenty's UI HTML routes
  (e.g. `/companies`, `/people`) instead of the REST API
  (`/rest/companies`, `/rest/people`). The HTML response was caught by
  the JSON-parse fallback and surfaced as an empty result, hiding the
  bug as "no records found" even when the workspace had data. Fixed by
  prefixing every list/get/activities path with `/rest/`. Verified live
  against `crm.lacneu.com` (1 company `Imóveis` now correctly surfaced
  with full `pageInfo` cursors). Affected tools: `twenty_people_list`,
  `twenty_people_get`, `twenty_companies_list`, `twenty_companies_get`,
  `twenty_opportunities_list`, `twenty_opportunities_get`,
  `twenty_notes_list`, `twenty_tasks_list`, `twenty_activities_list_for`.

### Tests

- Updated `people.test.ts` and `companies.test.ts` strict path assertions
  to match the corrected `/rest/*` URL.
- `activities.test.ts` already used `url.includes('/noteTargets')` which
  remains valid for the new `/rest/noteTargets` URL.
- Smoke-test (`twenty_workspace_info`) unaffected — it already pointed
  to the correct `/rest/metadata/objects` endpoint.

## [0.1.0] - 2026-05-02

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
