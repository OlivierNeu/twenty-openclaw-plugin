# Changelog

All notable changes to `@lacneu/twenty-openclaw` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-05-02

### Added — P7 Twenty Dashboards (12 tools)

End-to-end coverage of Twenty's PageLayout / PageLayoutTab /
PageLayoutWidget GraphQL API plus the chart-data resolvers. Lets the
agent **build, modify and inspect dashboards from the chat**, with
the same surface Twenty's own internal LLM uses (port of
`twenty-server/src/modules/dashboard/tools/`).

#### Dashboard-level (5 tools)

- `twenty_dashboards_list` — paginated list of workspace dashboards.
- `twenty_dashboard_get` — single call returning the dashboard record,
  its PageLayout, every tab, and every widget (joins REST + GraphQL).
- `twenty_dashboard_create_complete` — cascade `createPageLayout`
  (type=DASHBOARD) → POST `/rest/dashboards` → `createPageLayout
  Tab` → N × `createPageLayoutWidget`. One call, agent-friendly.
- `twenty_dashboard_duplicate` — wraps Twenty's `duplicateDashboard`
  custom mutation (records, layout, tabs, widgets cloned).
- `twenty_dashboard_delete` — soft-delete the dashboard record + HARD
  destroy the PageLayout. **Approval-gated.**
- `twenty_dashboard_replace_layout` — atomic refactor via
  `updatePageLayoutWithTabsAndWidgets` (anything not in the input is
  destroyed). **Approval-gated.**

#### Tab-level (3 tools)

- `twenty_dashboard_tab_add` — `createPageLayoutTab`. Auto-computes
  `position` to the next slot when omitted.
- `twenty_dashboard_tab_update` — `updatePageLayoutTab` (title,
  position, layoutMode).
- `twenty_dashboard_tab_delete` — `destroyPageLayoutTab`. **Approval-
  gated.** No automatic position compaction on remaining tabs.

#### Widget-level (4 tools)

- `twenty_dashboard_widget_add` — `createPageLayoutWidget` with the
  full configuration union (AGGREGATE_CHART / GAUGE_CHART / BAR_CHART
  / LINE_CHART / PIE_CHART / RECORD_TABLE / IFRAME / STANDALONE_RICH_
  TEXT). Tool description embeds the schema decision tree (per chart
  type) so the LLM can build configurations without round-tripping.
- `twenty_dashboard_widget_update` — `updatePageLayoutWidget` (partial
  patch).
- `twenty_dashboard_widget_delete` — `destroyPageLayoutWidget`.
  **Approval-gated.**
- `twenty_dashboard_widget_data` — fetches the widget config then
  dispatches to `barChartData` / `lineChartData` / `pieChartData`.
  Returns the computed series so the agent can read the same numbers
  the human sees on the dashboard. KPI configurations
  (AGGREGATE_CHART, GAUGE_CHART) return a hint pointing to the record
  aggregation API (no dedicated chart-data resolver upstream).

### Added — `TwentyClient.postGraphQL`

- New `client.postGraphQL<T>(query, variables, opts)` helper. POSTs to
  `<serverUrl>/metadata` with the same Bearer auth and the same
  retry/backoff policy as the REST request. Surfaces GraphQL `errors`
  arrays (HTTP 200 with `errors` set) as `TwentyApiError`. Endpoint
  switchable to `/graphql` if needed in the future, default `/metadata`.

### Added — TypeBox widget schemas

- `src/tools/widget-schemas.ts` — direct port of Twenty's canonical
  Zod schemas to TypeBox. Includes:
  - 12 `AggregateOperations` (MIN/MAX/AVG/SUM/COUNT, COUNT_UNIQUE_VALUES,
    COUNT_EMPTY/NOT_EMPTY, COUNT_TRUE/FALSE, PERCENTAGE_EMPTY/NOT_EMPTY).
  - 5 chart configurationType + RECORD_TABLE / IFRAME / STANDALONE_
    RICH_TEXT.
  - 4 PageLayoutType, 5 WidgetType (LLM subset), 9 GraphOrderBy + 8
    DateGranularity + 26 chart colors + 4 AxisNameDisplay + Bar
    layouts/group modes.
  - GridPositionSchema (12-col grid, KPI rowSpan 2-4, charts 6-8).

### Approval gating defaults — 4 new

`twenty_dashboard_delete`, `twenty_dashboard_tab_delete`,
`twenty_dashboard_widget_delete`, `twenty_dashboard_replace_layout`.

**Not gated** (deliberate): `twenty_dashboard_create_complete`,
`twenty_dashboard_duplicate`, `twenty_dashboard_tab_add`,
`twenty_dashboard_tab_update`, `twenty_dashboard_widget_add`,
`twenty_dashboard_widget_update`. Rationale: the LLM iterates rapidly
during construction (add → check → tweak → re-add); approval prompts
on every step would cripple the build flow. Only irreversible
destructions block.

### Tools count

**58 total** (up from 46 in v0.4.0): 1 introspection + 9 read +
1 timeline + 15 typed write + 6 helpers + 10 metadata + 5 generic
record + 12 dashboard.

### Live validation

- `createPageLayout(input: { name: "openclaw-permission-probe", type:
  DASHBOARD })` → 201 + `id`, then `destroyPageLayout(id)` → `true`,
  proving the API key has the `LAYOUTS` permission flag (admin keys
  inherit it automatically).
- Discovered `getPageLayouts` already returned the existing
  "My First Dashboard" (`type: DASHBOARD`) on the Ataraxis 2CF
  workspace — confirmed naming + auth + endpoint without any code
  change.
- `scripts/smoke-test-dashboards.mjs` exercises the full lifecycle
  on `crm.lacneu.com`: `dashboard_create_complete` (KPI on
  opportunities) → `dashboard_get` (REST + GraphQL join) →
  `dashboard_widget_add` (BAR_CHART by month) →
  `dashboard_widget_data` (returns the rendered series) →
  `dashboard_widget_update` (rename) → `dashboard_widget_delete` →
  `dashboard_delete`. **All 7 tools succeed live.**

### Notes — caveats discovered during smoke

- `WidgetConfiguration` is a 24-member GraphQL UNION (not JSON scalar
  in the response). The plugin embeds an inline-fragment block
  (`src/tools/widget-config-fragment.ts`) covering every member with
  full field selection. Add new members here when Twenty introduces
  new chart types.
- `RichTextBody`, `BarChartSeries`, `LineChartSeries`,
  `LineChartDataPoint`, `PieChartDataItem` are object types requiring
  sub-selections; the plugin queries them in the right shape.
- Twenty rejects `id` as a `primaryAxisGroupByFieldMetadataId` (every
  record is unique by id). Tool descriptions need to call this out
  for the LLM — currently only the relation-field caveat is in the
  description; consider expanding.
- Dashboard records live at `/rest/dashboards`, NOT `/rest/core/dashboards`
  (the OpenAPI doc example was misleading). The plugin uses the
  correct path.

### Tests

- 5 new unit tests (`dashboards.test.ts`):
  cascade ordering of `create_complete`, REST + GraphQL join in
  `dashboard_get`, BAR_CHART dispatch in `widget_data`, KPI hint
  fallback in `widget_data`, GraphQL `errors` array → tool failure.
- All 47 plugin tests pass.

## [0.4.0] - 2026-05-02

### Added — P5 Twenty Metadata API tools (10)

- `twenty_metadata_objects_list` / `_object_get` — discover standard +
  custom objects. Reuses `GET /rest/metadata/objects`.
- `twenty_metadata_object_create` / `_update` / `_delete` — full lifecycle
  on custom objects (`POST/PATCH/DELETE /rest/metadata/objects`).
- `twenty_metadata_fields_list` / `_field_get` — discover fields. The
  list tool routes to `GET /rest/metadata/objects/{id}` when an
  `objectMetadataId` filter is provided (Twenty rejects this filter on
  `/fields` query string).
- `twenty_metadata_field_create` / `_update` / `_delete` — full lifecycle
  on fields, with loose `type: string + options: object` schema (Twenty
  validates server-side against its 25+ field types).
- 6 metadata mutations approval-gated by default
  (`object_create/update/delete`, `field_create/update/delete`).
- Empirically validated: schema regeneration after `object_create` is
  **synchronous** (~50ms, single poll), so `/rest/<plural>` endpoints
  become available immediately for newly created custom objects.
- `metadata_object_delete` is **HARD delete** (irreversible — drops all
  records). Tool description and approval prompt severity reflect the
  risk explicitly.

### Added — P6 Generic record dispatch tools (5)

- `twenty_record_list` / `_get` / `_create` / `_update` / `_delete` —
  CRUD on **any** Twenty entity (standard or custom), with the entity
  plural name as a parameter.
- Entity name regex-validated pre-network (`^[a-zA-Z][a-zA-Z0-9]*$`) to
  reject path traversal (`people/../../etc/passwd` → rejected before
  any HTTP call is made).
- `twenty_record_delete` always approval-gated regardless of entity
  (cohérent avec the 5 typed `*_delete` tools).
- Body schema is loose (`Type.Object({}, {additionalProperties: true})`)
  — agent passes whatever fields it has, Twenty validates and surfaces
  actionable errors.
- Composes naturally with P5 metadata tools: agent creates custom object
  via P5 → populates records via P6, no plugin redeploy needed.

### Tools count

46 total (1 workspace + 9 read + 15 write + 6 P4 helpers + 10 P5 metadata
+ 5 P6 generic).

### Live validation

Full end-to-end lifecycle exercised on `crm.lacneu.com` (Ataraxis 2CF
workspace):
1. `metadata_object_create` → `Diagnostic ICOPE` (`icopeDiagnostics`)
2. `metadata_field_create` × 4 → `dateEvaluation` (DATE),
   `scoreCognitif` (NUMBER), `scoreMobilite` (NUMBER), `person` (RELATION
   MANY_TO_ONE → Person, with auto-generated inverse field
   `diagnosticsIcope` on Person)
3. `record_create` / `record_list` / `record_get` / `record_update` /
   `record_delete` (gated) on the new custom object
4. Cleanup: `metadata_field_delete` + `metadata_object_delete` (gated)

All with approval prompts at each destructive step, observed live.

## [0.3.0] - 2026-05-02

### Added — P4 business helpers (5 new + bulk_export from P4a)

- `twenty_export` — paginate any entity to JSON or CSV. Inline CSV
  RFC 4180 escape (no dependency), dot-notation flatten of nested
  objects (`name.firstName`, `domainName.primaryLinkUrl`).
- `twenty_people_find_similar` — strict matching by `email[ilike]`
  first, falls back to `name.firstName` / `name.lastName` `ilike`.
  No fuzzy library, no schema discovery — deterministic, ~30 lines.
- `twenty_people_dedup` / `twenty_companies_dedup` — return groups of
  records sharing the same exact key (email for People, domain URL
  for Companies). Read-only — no auto-merge in this release.
- `twenty_bulk_import_csv` — chunked POST batch (Twenty REST max 60),
  CSV path validated against `allowedImportPaths` (defaults to
  `/home/node/.openclaw/` and `/tmp/`) with `fs.realpathSync` to defeat
  symlink + path traversal attacks. Approval-gated. Supports `dry_run`.
- `twenty_summarize_relationship` — counts notes/tasks/calendar events
  for a Person/Company over a configurable window, returns
  `first_activity_at` / `last_activity_at`. **No scoring algorithm** —
  agent reasons over the facts.

### Added — config

- `allowedImportPaths` (string[]) — host-side prefix whitelist for
  `bulk_import_csv`. Default: `/home/node/.openclaw/`, `/tmp/`.

### Removed — P4a cleanup

- 5 `*_restore` tools removed (`people_restore`, `companies_restore`,
  `opportunities_restore`, `notes_restore`, `tasks_restore`) and the
  `buildRestoreTool` factory helper. **Reason:** Twenty 2.1 server
  returns 400 BadRequest on `/rest/restore/<entity>/{id}` despite the
  endpoint being declared in OpenAPI, and no GraphQL alternative
  works either (`restorePerson` mutation also returns
  `RECORD_NOT_FOUND`). Soft-deleted records can be restored manually
  through the Twenty UI or via direct DB update. The factory pattern
  is documented in commit `e952a2c` (tag `v0.2.0`) for re-adoption
  when Twenty fixes the upstream bug.

### Removed — `enrich_company` dropped from scope

- Originally planned for P4 but requires a real research call (which
  external provider, free tier limits, GDPR implications for cabinet
  conseil) that isn't a coding task. Reconsider in a future phase
  with a concrete provider choice.

### Tests

- 4 new unit tests (`find-similar`, `dedup`, `bulk-import` security,
  `summarize`). Existing tests adapted to the new approval list.
- Live verification on `crm.lacneu.com`: `find_similar('wix-team')`
  returns 3 candidates via email match; bulk-import path validation
  rejects `/etc/passwd`, `/tmp/../etc/passwd`, and symlinked bypasses.

## [0.2.0] - 2026-05-02

### Added — P3 write tools (15) + approval gating

- `*_create` / `*_update` / `*_delete` on People, Companies,
  Opportunities, Notes, Tasks (15 new tools).
- Soft-delete contract: every `*_delete` issues
  `DELETE /rest/<entity>/{id}?soft_delete=true`. Records remain in the
  database with a `deletedAt` timestamp and stay restorable through
  the Twenty UI.
- `before_tool_call` approval hook (mirror of `wix-openclaw` pattern):
  every tool name listed in `config.approvalRequired` triggers an
  approval prompt before any HTTP call. Defaults gate the 5 typed
  `*_delete` tools plus 5 future destructive ops.
- Approval directive specifies `severity: "critical"`,
  `timeoutMs: 600_000` (10 minutes), `timeoutBehavior: "deny"` (silence
  is refusal). The tool params snapshot (with `workspaceId` stripped)
  is shown to the operator.
- `mutates: true` flag now exercised by all write tools — the plugin's
  `readOnly: true` mode rejects them at the factory boundary, before
  any HTTP call.

### Added — factory helpers

- `buildCreateTool` / `buildUpdateTool` / `buildDeleteTool` in
  `_factory.ts` — keeps individual tool files thin (~80 lines per
  entity for 6 tools each).

### Tests

- 5 unit tests added (people CUD + approval gating + read-only
  enforcement). Same cap (max 5) as P2.

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
