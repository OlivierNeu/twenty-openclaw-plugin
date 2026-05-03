# Changelog

All notable changes to `@lacneu/twenty-openclaw` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.1] - 2026-05-03

### Fixed — `DEFAULT_APPROVAL_REQUIRED` desync with the manifest

The `DEFAULT_APPROVAL_REQUIRED` constant in `src/config.ts` was still
the P3+P5 list (14 entries). The plugin manifest
(`configSchema.properties.approvalRequired.default`) had been updated
to 24 entries to cover P6 (record_delete), P7 (dashboard_delete /
tab_delete / widget_delete / replace_layout) and P8 (workflow_delete
/ version_activate / version_deactivate / version_delete / workflow_run),
but the runtime path
`cfg.approvalRequired ?? DEFAULT_APPROVAL_REQUIRED` reads the code
constant — not the manifest default — so any instance without an
explicit operator override would silently leave **10 destructive
tools un-gated**.

After this release, instances that rely on the plugin default get the
full 24-entry list and the boot log will report
`24 approval-gated` instead of `14`. Operators who maintain their own
override in `plugins.entries.twenty-openclaw.config.approvalRequired`
should align it (or unset it to inherit the new default).

### Notes

- No tool surface change. No SDK breaking change.
- `openclaw.plugin.json` is unchanged in content; only the `version`
  field is bumped to `0.7.1`. The manifest already had the 24 entries
  since 0.7.0.
- A code comment at the top of `DEFAULT_APPROVAL_REQUIRED` now warns
  future maintainers to keep the constant byte-aligned with the
  manifest.

## [0.7.0] - 2026-05-02

### Compat — OpenClaw 2026.5.2 SDK breaking change

OpenClaw 2026.5.2 introduces a manifest contract for plugin tool
ownership: `api.registerTool()` calls are **rejected at runtime** for
tool names that are not declared in `contracts.tools` of the plugin
manifest.

Without this release, `@lacneu/twenty-openclaw` would load on
2026.5.2 with **0 tools registered** instead of 86 (the contract
violation is enforced silently or with a runtime warning depending
on the OpenClaw log level).

### Added — `contracts.tools` (86 entries)

- `openclaw.plugin.json` now declares every tool the plugin owns
  under `contracts.tools` as a flat array of strings. Mirrors the
  86 tools registered by `registerTwentyPlugin(api)`:
  - 1 introspection (`twenty_workspace_info`)
  - 9 typed read + 1 timeline (people / companies / opportunities /
    notes / tasks list+get + activities_list_for)
  - 15 typed write (5 entities × create/update/delete)
  - 6 helpers (export, find_similar, 2 dedup, bulk_import, summarize)
  - 10 metadata (5 objects + 5 fields)
  - 5 generic record dispatch
  - 12 dashboard (5 dashboard + 3 tab + 4 widget)
  - 25 workflow (5 workflow + 6 version + 9 step/edge + 4 run + 3
    logic-function)
  - 2 = 86 tools.

### Added — `toolMetadata._default` config signal

- Tells OpenClaw 2026.5.2's tool descriptor planner that every tool
  in this plugin requires `plugins.entries.twenty-openclaw.config.apiKey`
  to be configured. The platform skips loading the plugin runtime when
  the apiKey is missing (cheap availability check at reply startup,
  per the new manifest spec).

### Notes — what 2026.5.2 does NOT fix

- The safeguard compaction bugs (issues #15669, #7477, #71325, #44370)
  are **not addressed** in 2026.5.2. The codex-style provider edge case
  (`ownsCompaction=true` skips safeguard) is unchanged. Continue using
  the workarounds documented in `openclaw-notes/docs/RUNBOOK-CONTEXT-OVERFLOW.md`:
  `maxActiveTranscriptBytes`, `truncateAfterCompaction`, `notifyUser`,
  and `/compact` slash command.
- Codex provider naming (`openai-codex/gpt-5.5` vs `openai/gpt-5.5` +
  `agentRuntime.id: "codex"`) is **not breaking** — the old PI OAuth
  route stays supported. No config migration required for existing
  instances.

### Notes — useful improvements in 2026.5.2 (no plugin code change)

- `session.writeLock.acquireTimeoutMs` raised to 60 s by default —
  fewer user-visible lock timeouts during long compactions.
- Pre-compaction memory flush turn no longer rejected as empty user
  message by strict Anthropic providers.
- Implicit summarization fallback chain — Azure content-filter 400s
  can recover.
- One-time configured-plugin install repair runs automatically based
  on `meta.lastTouchedVersion` after the upgrade.

### Migration steps for instance owners

1. Bump the npm dependency to `@lacneu/twenty-openclaw@0.7.0` (or
   re-`openclaw plugins install @lacneu/twenty-openclaw` after the
   2026.5.2 upgrade so the install repair picks up v0.7.0).
2. `openclaw doctor --fix` after upgrading OpenClaw, to migrate any
   legacy keys (threadBindings, Discord per-channel agentId, etc.).
3. `openclaw config reload` to pick up the new manifest.
4. Verify in the gateway log: `twenty-openclaw: ready — 86 tool(s)
   registered, 24 approval-gated`.

## [0.6.0] - 2026-05-02

### Added — P8 Twenty Workflows (25 tools)

End-to-end coverage of Twenty's workflow surface: design / version /
edit / run / report. Mirrors the LLM tools Twenty's own internal AI
agent uses (port of `twenty-server/src/modules/workflow/workflow-tools/
tools/`).

#### Workflow-level (5 tools)

- `twenty_workflows_list` — paginated list of workspace workflows.
- `twenty_workflow_get` — joins Workflow + every WorkflowVersion +
  N most recent WorkflowRuns in a single call.
- `twenty_workflow_create_complete` — cascade
  `POST /rest/workflows` → `POST /rest/workflowVersions` (with
  trigger + steps inlined as JSON) → GraphQL edges → optional activation.
  Mirrors Twenty's internal `create_complete_workflow` ordering invariants.
- `twenty_workflow_duplicate` — wraps `duplicateWorkflow` mutation
  (clones workflow + versions + steps + edges).
- `twenty_workflow_delete` — HARD destroy (cascades to versions + runs).
  **Approval-gated.**

#### Version-level (6 tools)

- `twenty_workflow_version_get_current` — returns `lastPublishedVersionId`
  if set, else most recent DRAFT.
- `twenty_workflow_version_create_draft` — fork an existing version
  into a new DRAFT (`createDraftFromWorkflowVersion`). Required before
  editing an ACTIVE version.
- `twenty_workflow_version_activate` — sets status=ACTIVE.
  **Approval-gated** with explicit prompt warning about production
  impact (DATABASE_EVENT/CRON triggers fire automatically).
- `twenty_workflow_version_deactivate` — sets status=DEACTIVATED.
  **Approval-gated.**
- `twenty_workflow_version_archive` — sets status=ARCHIVED (reversible
  via `updateWorkflowVersion`, NOT approval-gated).
- `twenty_workflow_version_delete` — HARD destroy. **Approval-gated.**

#### Step + edge-level (9 tools)

- `twenty_workflow_step_add` — adds a step (one of 17 action types).
  For CODE steps, also auto-creates the underlying logicFunction.
- `twenty_workflow_step_update` — replaces a step's full configuration.
- `twenty_workflow_step_delete` — removes a step (drops incoming/outgoing
  edges).
- `twenty_workflow_step_duplicate` — clones a step.
- `twenty_workflow_edge_add` — connects source → target.
- `twenty_workflow_edge_delete` — removes an edge.
- `twenty_workflow_compute_step_output_schema` — pre-computes the JSON
  shape of a step's output so the agent can write correct
  `{{<step-id>.result.x}}` refs in downstream steps.
- `twenty_workflow_trigger_update` — replaces the trigger of a DRAFT
  WorkflowVersion.
- `twenty_workflow_positions_update` — bulk update of step + trigger
  visual positions.
- **None of the build tools are approval-gated** — the LLM iterates
  rapidly during workflow construction, friction would cripple the flow.

#### Run-level (4 tools)

- `twenty_workflow_run` — executes a WorkflowVersion. **Approval-gated**
  with an enriched prompt warning about side effects (SEND_EMAIL,
  HTTP_REQUEST, CREATE_RECORD, etc.) — the operator can deny and
  inspect via `twenty_workflow_get` before approving.
- `twenty_workflow_run_stop` — sets status=STOPPING on an in-flight run.
- `twenty_workflow_runs_list` — REST query with multi-filter:
  workflowId, workflowVersionId, status (single value or array for
  incident reports like `["FAILED", "STOPPED"]`), date range. Returns
  computed `durationMs` per run.
- `twenty_workflow_run_get` — full run detail formatted for reporting:
  per-step status + errors, aggregated `stepStatusCounts`, parent
  version snapshot, run duration.

#### Logic functions (3 tools)

- `twenty_logic_function_list` — `findManyLogicFunctions` (returns id,
  name, source, linked workflow/step ids).
- `twenty_logic_function_update_source` — replace TS source.
- `twenty_logic_function_execute` — sandboxed test execution.

### Added — `workflow-schemas.ts` TypeBox port

- Direct port of `twenty-shared/src/workflow/schemas/` (Zod → TypeBox).
- 4 trigger types fully typed (DATABASE_EVENT, MANUAL, CRON 4 sub-types,
  WEBHOOK GET/POST).
- 17 action types each with their action-specific settings shape:
  CODE, LOGIC_FUNCTION, SEND_EMAIL, DRAFT_EMAIL, CREATE_RECORD,
  UPDATE_RECORD, UPSERT_RECORD, DELETE_RECORD, FIND_RECORDS, FORM,
  FILTER, IF_ELSE, HTTP_REQUEST, AI_AGENT, ITERATOR, EMPTY, DELAY.
- StepFilter / StepFilterGroup / IfElseBranch shared types.
- Variable reference helper (`{{trigger.x}}`, `{{<step-id>.result.x}}`).

### Added — approval prompt enrichment

- Per-tool `TOOL_CONTEXT` map in `hooks/approval.ts`. The
  approval prompt now embeds a tool-specific warning paragraph for
  the 5 high-risk workflow tools + `twenty_dashboard_replace_layout`,
  so the operator sees the specific blast radius (e.g. "this RUNS THE
  WORKFLOW — every step with side effects is executed for real").

### Added — `TwentyClient.logger` exposed

- The `logger` field on TwentyClient is now `readonly` instead of
  `private`, so tool implementations can warn about non-fatal failures
  (e.g. an optional follow-up call inside `workflow_create_complete`).

### Approval gating defaults — 5 new

`twenty_workflow_delete`, `twenty_workflow_version_activate`,
`twenty_workflow_version_deactivate`, `twenty_workflow_version_delete`,
`twenty_workflow_run`.

### Tools count

**83 total** (up from 58 in v0.5.0): 1 introspection + 9 read +
1 timeline + 15 typed write + 6 helpers + 10 metadata + 5 generic
record + 12 dashboard + 25 workflow.

### Required permission — WORKFLOWS

Workflow build (`*_step_*`, `*_edge_*`, `*_trigger_update`,
`*_positions_update`, `compute_step_output_schema`) and action
(`run`, `activate`, `deactivate`, `stop`, `create_draft`, `duplicate`)
mutations require the API key user to have the `WORKFLOWS` permission
flag. Standard CRUD on workflow records (list, get, create_complete,
delete, runs_list, run_get) needs only entity-level read/write.

Activate the flag in Twenty: **Settings → Members & Roles → Roles →
[Admin] → check `Workflows`**. Without it, Twenty returns
`Forbidden resource (FORBIDDEN)` on action mutations — mapped by the
plugin to a clean tool failure.

### Live validation

- `createWorkflow` REST + `destroyWorkflow` GraphQL OK on
  `crm.lacneu.com` (Ataraxis 2CF) without WORKFLOWS perm.
- `runWorkflowVersion` rejected with `Forbidden resource` as expected
  when WORKFLOWS perm is absent on the API key user.
- 5 unit tests added (`workflows.test.ts`):
  cascade ordering of `create_complete`, run_get formatting (status
  counts + duration), approval prompt enrichment for `workflow_run`
  and `version_activate`, FORBIDDEN error mapping.
- All 52 plugin tests pass.

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
