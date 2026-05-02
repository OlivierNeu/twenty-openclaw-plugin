# `@lacneu/twenty-openclaw`

Twenty CRM plugin for [OpenClaw](https://openclaw.ai). Lets an OpenClaw
agent **discover, model and operate** any Twenty workspace — read and
write the standard entities (People, Companies, Opportunities, Notes,
Tasks), create custom objects and fields on the fly via the Metadata
API, then CRUD their records — with workspace whitelisting, approval
gating on every destructive operation, an optional global read-only
switch, and a small set of opinionated business helpers (export, dedup,
bulk import, similarity search, relationship summary).

> **Status: P0 → P8 shipped.** 83 tools, end-to-end validated live
> against `crm.lacneu.com` (Ataraxis). The plugin currently ships:
>
> - **1** introspection tool (`twenty_workspace_info`).
> - **9** typed read tools (list/get on People, Companies,
>   Opportunities, Notes, Tasks).
> - **1** cross-record activities timeline (`twenty_activities_list_for`).
> - **15** typed write tools (`create`/`update`/`delete` on the same
>   five entities).
> - **6** business helpers (`export`, `people_find_similar`,
>   `people_dedup`, `companies_dedup`, `bulk_import_csv`,
>   `summarize_relationship`).
> - **10** Twenty Metadata API tools (custom-objects + fields lifecycle).
> - **5** generic record-dispatch tools that work on **any** entity,
>   standard or custom (`record_list/get/create/update/delete`).
> - **12** dashboard tools — build, modify, and inspect dashboards
>   (PageLayouts + tabs + widgets + chart-data) directly from the chat.
> - **25** workflow tools — design, version, activate, run, and report
>   on workflows (4 trigger types, 17 action types, runs + logic
>   functions) directly from the chat.
> - **`before_tool_call` approval hook** gating 24 destructive ops by
>   default, with per-tool context warnings on the 5 high-risk workflow
>   ops.

---

## Overview

| Field | Value |
|---|---|
| Plugin id | `twenty-openclaw` |
| npm package | `@lacneu/twenty-openclaw` |
| OpenClaw compat | `pluginApi >= 2026.4.0`, `minGatewayVersion >= 2026.4.0` |
| Twenty server tested | 2.1 (REST + Metadata REST) |
| License | MIT |
| Tools prefix | `twenty_*` |

The plugin talks to the Twenty REST API (`/rest/...`) and the Twenty
Metadata REST API (`/rest/metadata/...`) using a single API key sent as
`Authorization: Bearer <key>`. It refuses to call any workspace UUID
that isn't in `allowedWorkspaceIds`.

## Install

### Via OpenClaw CLI (recommended once published)

```bash
openclaw plugins install @lacneu/twenty-openclaw
```

### From source (local development)

```bash
git clone https://github.com/OlivierNeu/twenty-openclaw-plugin.git
cd twenty-openclaw-plugin
npm install
npm run build
# Then point your OpenClaw instance at the local checkout via
# plugins.entries["twenty-openclaw"].path.
```

## Configuration

Configuration goes under `plugins.entries["twenty-openclaw"].config` in
your `openclaw.json`. Every string field supports `${ENV_VAR}`
substitution.

```json
{
  "plugins": {
    "allow": ["twenty-openclaw"],
    "entries": {
      "twenty-openclaw": {
        "config": {
          "enabled": true,
          "apiKey": "${TWENTY_API_KEY}",
          "serverUrl": "https://crm.lacneu.com",
          "allowedWorkspaceIds": ["${TWENTY_WORKSPACE_ID}"],
          "defaultWorkspaceId": "${TWENTY_WORKSPACE_ID}",
          "approvalRequired": [
            "twenty_people_delete",
            "twenty_companies_delete",
            "twenty_opportunities_delete",
            "twenty_notes_delete",
            "twenty_tasks_delete",
            "twenty_dedup_auto_merge",
            "twenty_bulk_import_csv",
            "twenty_bulk_delete",
            "twenty_metadata_object_create",
            "twenty_metadata_object_update",
            "twenty_metadata_object_delete",
            "twenty_metadata_field_create",
            "twenty_metadata_field_update",
            "twenty_metadata_field_delete",
            "twenty_record_delete",
            "twenty_dashboard_delete",
            "twenty_dashboard_tab_delete",
            "twenty_dashboard_widget_delete",
            "twenty_dashboard_replace_layout",
            "twenty_workflow_delete",
            "twenty_workflow_version_activate",
            "twenty_workflow_version_deactivate",
            "twenty_workflow_version_delete",
            "twenty_workflow_run"
          ],
          "allowedImportPaths": [
            "/home/node/.openclaw/",
            "/tmp/"
          ],
          "readOnly": false,
          "logLevel": "info"
        }
      }
    }
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch — disables all tools when false. |
| `apiKey` | string | — | Twenty API key. Sent as `Authorization: Bearer <key>`. |
| `serverUrl` | string | `https://crm.lacneu.com` | Base URL of the Twenty server (no trailing slash). |
| `allowedWorkspaceIds` | string[] | `[]` | Whitelist of workspace UUIDs. Empty list ⇒ every workspace call is rejected. |
| `defaultWorkspaceId` | string | first allowed | Workspace UUID used when a tool doesn't specify one. Must be in `allowedWorkspaceIds`. |
| `approvalRequired` | string[] | 24 destructive tool names | Triggers an approval prompt via the `before_tool_call` hook. |
| `allowedImportPaths` | string[] | `["/home/node/.openclaw/", "/tmp/"]` | Host-side prefix whitelist for `bulk_import_csv`. Validated with `fs.realpathSync` to defeat symlink + `..` traversal attacks. |
| `readOnly` | boolean | `false` | When true, every tool with `mutates: true` is rejected at the plugin layer before any HTTP call. |
| `logLevel` | string | `info` | `debug` includes request bodies (be mindful of PII). |

## Tools

### Introspection (1)

| Tool | Description | Mutates? |
|---|---|---|
| `twenty_workspace_info` | List all metadata objects (standard + custom) of the configured workspace, with field counts. | No |

### Typed read (9 + 1 timeline)

| Tool | Description | Mutates? |
|---|---|---|
| `twenty_people_list` / `_get` | List + fetch-by-id People. Cursor pagination via `pageInfo.endCursor` + `starting_after`. | No |
| `twenty_companies_list` / `_get` | List + fetch-by-id Companies. | No |
| `twenty_opportunities_list` / `_get` | List + fetch-by-id Opportunities. | No |
| `twenty_notes_list` | List Notes. (Use `twenty_activities_list_for` for record-attached notes.) | No |
| `twenty_tasks_list` | List Tasks. (Use `twenty_activities_list_for` for record-attached tasks.) | No |
| `twenty_activities_list_for` | Cross-record timeline (notes + tasks) attached to a Person, Company, or Opportunity. | No |

Filter syntax follows the Twenty REST conventions, e.g.
`name[ilike]:%acme%`, `domainName.primaryLinkUrl[ilike]:%acme.com%`,
`employees[gte]:50`, `createdAt[gte]:2026-01-01`.

### Typed write (15)

| Tool | Description | Mutates? |
|---|---|---|
| `twenty_people_create` / `_update` / `_delete` | Full CUD on People. `_delete` is approval-gated. | Yes |
| `twenty_companies_create` / `_update` / `_delete` | Full CUD on Companies. `_delete` is approval-gated. | Yes |
| `twenty_opportunities_create` / `_update` / `_delete` | Full CUD on Opportunities. `_delete` is approval-gated. | Yes |
| `twenty_notes_create` / `_update` / `_delete` | Full CUD on Notes. `_delete` is approval-gated. | Yes |
| `twenty_tasks_create` / `_update` / `_delete` | Full CUD on Tasks. `_delete` is approval-gated. | Yes |

**Soft-delete contract.** The 5 typed `*_delete` tools issue
`DELETE /rest/<entity>/{id}?soft_delete=true`. Records remain in the
database with a `deletedAt` timestamp and stay restorable through the
Twenty UI. Hard-delete on entity records is intentionally not exposed.

> **Note — restore endpoint not exposed.** Twenty 2.1 declares
> `PATCH /rest/restore/<entity>/{id}` in OpenAPI but the server returns
> 400 BadRequest at runtime, and the GraphQL alternative
> (`restorePerson` mutation) returns `RECORD_NOT_FOUND`. The factory
> pattern remains in git history at tag `v0.2.0` and will be re-added
> once Twenty fixes the upstream bug. In the meantime, restore through
> the Twenty UI.

### Business helpers (6)

| Tool | Description | Mutates? |
|---|---|---|
| `twenty_export` | Paginate any entity (typed or custom) to JSON or CSV. RFC 4180 escape, dot-notation flatten of nested objects (`name.firstName`, `domainName.primaryLinkUrl`, ...). | No |
| `twenty_people_find_similar` | Find candidate matches for a Person by exact `email[ilike]`, then fallback to `name.firstName` / `name.lastName` `ilike`. Deterministic, no fuzzy library. | No |
| `twenty_people_dedup` | Group People sharing the same email. Read-only (no auto-merge). | No |
| `twenty_companies_dedup` | Group Companies sharing the same `domainName.primaryLinkUrl`. Read-only. | No |
| `twenty_bulk_import_csv` | Import a CSV in chunked POST batches (Twenty REST max 60 per call). Path is validated against `allowedImportPaths` with `realpathSync` to defeat symlink + `..` bypass. Supports `dry_run`. Approval-gated. | Yes |
| `twenty_summarize_relationship` | Count notes/tasks/calendar events on a Person or Company over a configurable window (`since` / `until`). Returns counts + first/last activity timestamps. **No scoring algorithm** — agent reasons over the facts. | No |

### Twenty Metadata API (10)

These tools call `/rest/metadata/objects` and `/rest/metadata/fields`
and let the agent **shape the workspace itself** without leaving the
chat.

| Tool | Description | Mutates? |
|---|---|---|
| `twenty_metadata_objects_list` | List standard + custom objects (alias of the introspection tool with richer filtering). | No |
| `twenty_metadata_object_get` | Fetch one object by id, including its full field list. | No |
| `twenty_metadata_object_create` | Create a custom object (`nameSingular`, `namePlural`, `labelSingular`, `labelPlural`, optional `icon`, `description`). Approval-gated. | Yes |
| `twenty_metadata_object_update` | Patch an existing custom object's labels/icon/description. Approval-gated. | Yes |
| `twenty_metadata_object_delete` | **HARD delete** a custom object — irreversible, drops every record. Approval-gated. | Yes |
| `twenty_metadata_fields_list` | List fields. With `objectMetadataId` filter, routes to `GET /rest/metadata/objects/{id}` (Twenty rejects this filter on the `/fields` query string). | No |
| `twenty_metadata_field_get` | Fetch one field by id. | No |
| `twenty_metadata_field_create` | Create a field (`type` + Twenty-validated `options`). Loose schema — Twenty validates the options server-side against its 25+ field types. Approval-gated. | Yes |
| `twenty_metadata_field_update` | Patch a field's labels/options. Approval-gated. | Yes |
| `twenty_metadata_field_delete` | **HARD delete** a field — irreversible, drops the column. Approval-gated. | Yes |

**Synchronous schema regeneration.** After
`metadata_object_create`, the new `/rest/<plural>` endpoint is
available within ~50 ms. The plugin does **not** poll — the very next
`record_create` call against the new entity succeeds.

### Generic record dispatch (5)

CRUD on any entity (standard or custom) parameterised by entity name.
Composes naturally with the Metadata tools: agent creates a custom
object via P5 → populates records via P6, no plugin redeploy needed.

| Tool | Description | Mutates? |
|---|---|---|
| `twenty_record_list` | List records of any entity. Same filter/pagination semantics as the typed list tools. | No |
| `twenty_record_get` | Fetch one record by id. | No |
| `twenty_record_create` | Create a record. Loose body schema (`additionalProperties: true`). | Yes |
| `twenty_record_update` | Patch a record. | Yes |
| `twenty_record_delete` | Soft-delete a record. **Always** approval-gated regardless of entity. | Yes |

The entity name is regex-validated pre-network (`^[a-zA-Z][a-zA-Z0-9]*$`)
to reject path-traversal attempts (`people/../../etc/passwd` → rejected
before any HTTP call is made).

### Dashboards (12 tools)

Build, modify, and inspect Twenty dashboards from the chat. Mirrors the
exact LLM contract Twenty's own internal AI agent uses (port of
`twenty-server/src/modules/dashboard/tools/`), so the agent gets a
proven authoring surface — without needing the agent to learn Twenty's
internals.

A Twenty dashboard is the union of a `dashboards` workspace record
(with `title`, `pageLayoutId`, `position`) and a `PageLayout` of
`type=DASHBOARD` (containing tabs, themselves containing widgets on a
12-column grid). These tools coordinate both layers transparently.

#### Dashboard-level (5)

| Tool | Description | Mutates? |
|---|---|---|
| `twenty_dashboards_list` | Paginated list of workspace dashboards (id, title, pageLayoutId, timestamps). | No |
| `twenty_dashboard_get` | Single call returning dashboard + PageLayout + tabs + widgets (REST + GraphQL joined). | No |
| `twenty_dashboard_create_complete` | Cascade creation: layout + dashboard record + first tab + N widgets in one tool call. Returns every id created. | Yes |
| `twenty_dashboard_duplicate` | Wraps Twenty's `duplicateDashboard` mutation (records, layout, tabs, widgets cloned). | Yes |
| `twenty_dashboard_delete` | Soft-delete the dashboard record + HARD destroy the PageLayout. **Approval-gated.** | Yes |
| `twenty_dashboard_replace_layout` | Atomic refactor via `updatePageLayoutWithTabsAndWidgets`. Anything not listed is destroyed. **Approval-gated.** | Yes |

#### Tab-level (3)

| Tool | Description | Mutates? |
|---|---|---|
| `twenty_dashboard_tab_add` | `createPageLayoutTab`. Auto-computes `position` to the next slot when omitted. | Yes |
| `twenty_dashboard_tab_update` | `updatePageLayoutTab` (title / position / layoutMode partial). | Yes |
| `twenty_dashboard_tab_delete` | HARD destroy a tab and every widget it contains. **Approval-gated.** | Yes |

#### Widget-level (4)

| Tool | Description | Mutates? |
|---|---|---|
| `twenty_dashboard_widget_add` | `createPageLayoutWidget` with the full configuration union — AGGREGATE_CHART (KPI), GAUGE_CHART, BAR_CHART, LINE_CHART, PIE_CHART, RECORD_TABLE, IFRAME, STANDALONE_RICH_TEXT. The tool description embeds the per-type schema decision tree so the LLM can author configurations without round-tripping. | Yes |
| `twenty_dashboard_widget_update` | `updatePageLayoutWidget` (partial patch on title / type / gridPosition / objectMetadataId / configuration / conditionalAvailabilityExpression). | Yes |
| `twenty_dashboard_widget_delete` | HARD destroy a widget. **Approval-gated.** | Yes |
| `twenty_dashboard_widget_data` | Compute the rendered data for a chart (BAR / LINE / PIE) by dispatching to Twenty's chart-data resolvers. KPI charts (AGGREGATE / GAUGE) return a hint pointing to the record aggregation API. Lets the agent **read the same numbers the user sees on the dashboard**. | No |

#### Grid system

12 columns (0-11). Typical sizes: KPI rowSpan 2-4, charts 6-8. Full
width = `columnSpan: 12`, half = 6, third = 4, quarter = 3.

#### Configuration recipes (excerpt)

| Chart | Required fields |
|---|---|
| `AGGREGATE_CHART` (KPI) | `aggregateFieldMetadataId`, `aggregateOperation` |
| `BAR_CHART` | + `primaryAxisGroupByFieldMetadataId`, `layout` (VERTICAL\|HORIZONTAL). For RELATION/composite groupBy: also `primaryAxisGroupBySubFieldName` (e.g. `"name"`). |
| `LINE_CHART` | + `primaryAxisGroupByFieldMetadataId` (typically a date field, with `primaryAxisDateGranularity`) |
| `PIE_CHART` | + `groupByFieldMetadataId` (different field name from BAR/LINE!) |
| `GAUGE_CHART` | + `rangeMin`, `rangeMax` |
| `RECORD_TABLE` | + `viewId` (must create a TABLE view first; reusing a record-index view is forbidden) |
| `IFRAME` | + `url` |
| `STANDALONE_RICH_TEXT` | + `body.markdown` |

Aggregations available: `COUNT`, `COUNT_UNIQUE_VALUES`, `COUNT_EMPTY`,
`COUNT_NOT_EMPTY`, `COUNT_TRUE`, `COUNT_FALSE`, `SUM`, `AVG`, `MIN`,
`MAX`, `PERCENTAGE_EMPTY`, `PERCENTAGE_NOT_EMPTY`.

Date granularities for time-bucketed charts: `DAY`, `WEEK`, `MONTH`,
`QUARTER`, `YEAR`, `DAY_OF_THE_WEEK`, `MONTH_OF_THE_YEAR`,
`QUARTER_OF_THE_YEAR`.

#### Approval gating philosophy

Only **irreversible destructions** are gated by default:
`dashboard_delete`, `dashboard_replace_layout`, `tab_delete`,
`widget_delete`. Construction tools (`*_add`, `*_update`,
`create_complete`, `duplicate`) are **not gated** — the LLM iterates
during build (add → check → tweak), and approval prompts on every step
would cripple the flow.

#### Required permission

The Twenty API key must hold the `LAYOUTS` permission flag. Workspace-
admin keys inherit it automatically; restricted keys require an admin
to grant it explicitly through Twenty's role configuration.

### Workflows (25 tools)

Design, version, activate, run, and report on Twenty workflows — the
full lifecycle from chat. Mirrors Twenty's internal workflow LLM
tooling (`twenty-server/src/modules/workflow/workflow-tools/tools/`).

A Twenty workflow is the union of 4 entities:

```
Workflow (record, REST /rest/workflows)
   ├─ versions[]  ─→ WorkflowVersion (DRAFT/ACTIVE/DEACTIVATED/ARCHIVED)
   │                   ├─ trigger (JSON: DATABASE_EVENT|MANUAL|CRON|WEBHOOK)
   │                   └─ steps[]  ─→ WorkflowAction (17 types)
   │                                   id, name, type, valid, settings, position
   ├─ runs[]      ─→ WorkflowRun (each execution: status + state.stepInfos)
   └─ automatedTriggers[]
```

#### Workflow-level (5)

| Tool | Description | Mutates? |
|---|---|---|
| `twenty_workflows_list` | Paginated list (id, name, statuses[], lastPublishedVersionId, timestamps). | No |
| `twenty_workflow_get` | Joins workflow record + every WorkflowVersion + N most recent runs in one call. | No |
| `twenty_workflow_create_complete` | Cascade: workflow record + version + N×steps + N×edges + (optional) activation. The big one. | Yes |
| `twenty_workflow_duplicate` | `duplicateWorkflow` mutation (clones workflow + versions + steps + edges). | Yes |
| `twenty_workflow_delete` | HARD destroy (cascades to versions + runs). **Approval-gated.** | Yes |

#### Version-level (6)

| Tool | Description | Mutates? |
|---|---|---|
| `twenty_workflow_version_get_current` | Returns `lastPublishedVersionId` if set, else most recent DRAFT. | No |
| `twenty_workflow_version_create_draft` | Fork an existing version into a new DRAFT (required before editing an ACTIVE version). | Yes |
| `twenty_workflow_version_activate` | Set status=ACTIVE — **starts the workflow running in production**. **Approval-gated** with explicit warning. | Yes |
| `twenty_workflow_version_deactivate` | Set status=DEACTIVATED. **Approval-gated.** | Yes |
| `twenty_workflow_version_archive` | Set status=ARCHIVED (reversible — not gated). | Yes |
| `twenty_workflow_version_delete` | HARD destroy. **Approval-gated.** | Yes |

#### Step + edge-level (9)

| Tool | Description | Mutates? |
|---|---|---|
| `twenty_workflow_step_add` | Add a step (one of 17 action types). For CODE, also auto-creates the underlying logicFunction. | Yes |
| `twenty_workflow_step_update` | Replace a step's full configuration. | Yes |
| `twenty_workflow_step_delete` | Remove a step (drops incoming/outgoing edges). | Yes |
| `twenty_workflow_step_duplicate` | Clone a step. | Yes |
| `twenty_workflow_edge_add` | Connect source → target. Use source="trigger" for edges from the trigger. | Yes |
| `twenty_workflow_edge_delete` | Remove an edge. | Yes |
| `twenty_workflow_compute_step_output_schema` | Pre-compute the JSON shape of a step's output (so the agent can write correct `{{<step-id>.result.x}}` refs in downstream steps). | No |
| `twenty_workflow_trigger_update` | Replace the trigger of a DRAFT version. | Yes |
| `twenty_workflow_positions_update` | Bulk update visual positions (cosmetic). | Yes |

**None gated by default.** The LLM iterates rapidly during build (add → check → tweak); approval prompts on every step would cripple the flow.

#### Run-level (4)

| Tool | Description | Mutates? |
|---|---|---|
| `twenty_workflow_run` | **Execute a WorkflowVersion**. Every step with side effects (SEND_EMAIL, HTTP_REQUEST, CREATE_RECORD, …) is executed for real. **Approval-gated** with explicit side-effects warning. | Yes |
| `twenty_workflow_run_stop` | Stop an in-flight run (sets status=STOPPING). | Yes |
| `twenty_workflow_runs_list` | List runs with multi-filter (workflow / version / status single or array / date range). Returns durationMs per run. | No |
| `twenty_workflow_run_get` | Full run detail formatted for reporting: per-step status + errors, aggregated stepStatusCounts, parent version snapshot. | No |

#### Logic functions (3)

For CODE workflow steps. Live on `/metadata`.

| Tool | Description | Mutates? |
|---|---|---|
| `twenty_logic_function_list` | List all logicFunctions in the workspace. | No |
| `twenty_logic_function_update_source` | Replace the TypeScript source of a function. | Yes |
| `twenty_logic_function_execute` | Sandboxed test run with arbitrary input. | Yes |

#### Trigger types and configurations

| Type | Settings | Use case |
|---|---|---|
| `DATABASE_EVENT` | `{ eventName: "objectName.action" }` (action ∈ created/updated/deleted/upserted) | Auto-react to record changes |
| `MANUAL` | `{ availability: GLOBAL \| SINGLE_RECORD \| BULK_RECORDS }` | User-launched (button on record / global / bulk) |
| `CRON` | `{ type: DAYS\|HOURS\|MINUTES, schedule }` or `{ type: CUSTOM, pattern: cronExpr }` | Scheduled |
| `WEBHOOK` | `{ httpMethod: GET\|POST, authentication: API_KEY\|null, expectedBody?: object }` | External HTTP-triggered |

#### Action types — the 17 step types

Record CRUD: `CREATE_RECORD`, `UPDATE_RECORD`, `UPSERT_RECORD`,
`DELETE_RECORD`, `FIND_RECORDS`. Email: `SEND_EMAIL`, `DRAFT_EMAIL`.
Logic: `IF_ELSE`, `FILTER`, `ITERATOR`. AI: `AI_AGENT`. External:
`HTTP_REQUEST`. Code: `CODE` (TS function), `LOGIC_FUNCTION` (alias).
UX: `FORM`, `DELAY`, `EMPTY`. The `workflow-schemas.ts` file ports
each action's settings shape directly from `twenty-shared/workflow/
schemas/` so the LLM sees the canonical contract.

#### Variable references between steps

```
{{trigger.object.fieldName}}       — DATABASE_EVENT triggered record
{{trigger.record.fieldName}}       — MANUAL with single-record availability
{{trigger.body.fieldName}}         — WEBHOOK POST body
{{<step-uuid>.result.fieldName}}   — earlier step's output (UUID, not name)
```

Discover step ids via `twenty_workflow_get`. Pre-compute output
schemas via `twenty_workflow_compute_step_output_schema` before
referencing.

#### Required permission

The Twenty API key must be linked to a user who has the `WORKFLOWS`
permission flag. **Settings Twenty → Members & Roles → Roles → [your
role, typically Admin] → check `Workflows`**. Without it, Twenty
returns `Forbidden resource (FORBIDDEN)` on action mutations
(run/activate/deactivate/stop/createDraft/duplicate, plus the step +
edge mutations). Standard CRUD on workflow records (list, get,
create_complete, delete, runs_list, run_get) only requires entity-
level read/write.

#### Use case — campaigns

Concretely, an agent can build campaign workflows like:

```text
Trigger MANUAL (with BULK_RECORDS availability on Company)
  → step FIND_RECORDS on Company filtered by tag/label
  → step ITERATOR on the result
    → SEND_EMAIL inside the iterator
    → CREATE_RECORD (Note linked to the company) for tracking
```

`twenty_workflow_create_complete` writes all this in one cascade. The
operator activates with `twenty_workflow_version_activate`, then
launches with `twenty_workflow_run` (both approval-gated). After
execution, `twenty_workflow_run_get` returns the run's
stepStatusCounts and per-step errors so the agent can write a report.

## Custom data modelling workflow (live demo)

End-to-end flow exercised against the Ataraxis 2CF workspace:

```text
1. Agent: "I need to track ICOPE diagnostics for our patients"
2. metadata_object_create  →  Diagnostic ICOPE  (icopeDiagnostics)
   • Approval prompt → operator approves
3. metadata_field_create   →  dateEvaluation     (DATE)
4. metadata_field_create   →  scoreCognitif      (NUMBER)
5. metadata_field_create   →  scoreMobilite      (NUMBER)
6. metadata_field_create   →  person             (RELATION many_to_one → Person)
   • Twenty auto-creates the inverse field `diagnosticsIcope` on Person
7. record_create           →  first ICOPE diagnostic for John Doe
   • Operator: "approval — yes, this is the format I want"
8. record_list             →  back-reference works through the inverse field
9. record_update           →  fix a wrong score
10. record_delete (gated)  →  soft-delete the demo record
```

Every destructive step (`metadata_*_create`, `*_update`, `*_delete`,
`record_delete`) prompts the operator through the active OpenClaw
channel before any HTTP call.

## Approval gating (`before_tool_call`)

Every tool name listed in `approvalRequired` triggers a `before_tool_call`
hook that returns a `requireApproval` directive to the OpenClaw runtime.
The runtime then surfaces the prompt to the operator via the active
channel (Telegram inline button, Control UI, ...) and only proceeds when
the operator approves. Denied or timed-out calls (10 min default) are
rejected without ever reaching Twenty.

Approval prompts include:

- `severity: "critical"` — the operator's UI flags it appropriately.
- `timeoutMs: 600_000` (10 minutes).
- `timeoutBehavior: "deny"` — silence is refusal.
- A JSON snapshot of the tool parameters (with `workspaceId` stripped).

The hook is wired automatically when the plugin loads — no extra
configuration is required on the host side. To audit or tweak the gated
list, override `approvalRequired` in `plugins.entries.twenty-openclaw.config`:

```bash
openclaw config set 'plugins.entries.twenty-openclaw.config.approvalRequired' \
  '["twenty_people_delete","twenty_metadata_object_delete","twenty_record_delete"]' \
  --strict-json
```

Pass an empty array to disable approval gating entirely (not recommended).

> **Note on hook policy flags.** OpenClaw 2026.4.x introduced
> `plugins.entries.<id>.hooks.allowConversationAccess` — but that toggle
> only governs `llm_input` / `llm_output` / `agent_end` hooks (raw
> conversation surfaces). `before_tool_call` is not in that family, so no
> manifest-level or config-level toggle is required for this plugin's
> approval hook.

## Examples

Once the plugin is loaded, an OpenClaw agent can simply call:

```text
twenty_workspace_info()
```

and receive a JSON summary like:

```json
{
  "workspaceUrl": "https://crm.lacneu.com",
  "objectCount": 12,
  "customObjectCount": 2,
  "objects": [
    { "nameSingular": "person", "namePlural": "people", "labelSingular": "Person", "isCustom": false, "isActive": true, "isSystem": false, "fieldCount": 24 },
    { "nameSingular": "company", "namePlural": "companies", "labelSingular": "Company", "isCustom": false, "isActive": true, "isSystem": false, "fieldCount": 18 },
    "..."
  ]
}
```

## Smoke test

```bash
cp .env.smoketest .env.smoketest.local   # do not commit local copy
# edit .env.smoketest.local with real values
TWENTY_API_KEY=... TWENTY_SERVER_URL=... TWENTY_WORKSPACE_ID=... npm run smoke-test
```

The script lives in `scripts/smoke-test.mjs` and runs one
`twenty_workspace_info` call against the configured server. It exits 0
on success, 1 on tool failure, 2 on missing env vars.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

`npm test` compiles `src/**` + `test/**` to `dist-test/` and runs
`node --test`. CI matrices node 22 + node 24.

## Roadmap

- **P0** — repo + license + .gitignore. ✅
- **P1** — bootstrap: manifest, package, single read-only tool, smoke
  script, CI/Release workflows. ✅
- **P2** — domain read tools (list/get for the five entities + cross-record
  activities timeline). ✅
- **P3** — typed write tools (create/update/delete on the five entities)
  + `before_tool_call` approval gating on every destructive operation. ✅
- **P4** — business helpers: `export`, `people_find_similar`,
  `people_dedup`, `companies_dedup`, `bulk_import_csv`,
  `summarize_relationship`. ✅
  *(restore + enrich dropped from scope — see CHANGELOG 0.3.0.)*
- **P5** — Twenty Metadata API: 10 tools to create / update / delete
  custom objects and fields. ✅
- **P6** — Generic record dispatch: 5 tools to CRUD any entity (standard
  or custom). ✅
- **P7** — Dashboards: 12 tools to build / modify / inspect dashboards
  (PageLayout + tabs + widgets + chart-data). ✅
  *(approval gates only irreversible destructions; construction stays
  friction-free)*
- **P8** — Workflows: 25 tools (5 workflow + 6 version + 9 step/edge +
  4 run + 3 logic-function). Design / activate / run / report end-to-
  end. Approval gates only irreversible destructions + production-
  impact ops (activate / deactivate / run). ✅

### Future

- `twenty_<entity>_restore` once Twenty fixes the upstream REST/GraphQL
  restore bug.
- `twenty_enrich_company` once a concrete data provider is selected
  (free-tier limits + GDPR for cabinet conseil to validate).
- Real OpenClaw OTEL tracing through the runtime tracer (waiting on SDK
  exposure).

## License

MIT — see [LICENSE](./LICENSE).
