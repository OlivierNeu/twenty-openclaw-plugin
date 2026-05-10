# Changelog

All notable changes to `@lacneu/twenty-openclaw` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.2] - 2026-05-10

### Fixed — `twenty_page_layout_duplicate` cascade widgets utilisait l'alias `gridPosition: position` désormais invalide

Repéré par Codex review sur le diff v0.8.2. Lorsque
`PAGE_LAYOUT_WIDGET_FRAGMENT` a été enrichi pour exposer `position`
comme UNION (Grid / VerticalList / Canvas), la query `DupSrcWidgets`
de la cascade non-DASHBOARD a continué d'utiliser l'ancien alias plat
`gridPosition: position` sans inline fragments — GraphQL aurait rejeté
la query au runtime avec « Field "position" of type
"PageLayoutWidgetPosition" must have a sub selection ».

### Changed

- `src/tools/page-layouts.ts — twenty_page_layout_duplicate` (cascade
  manuelle non-DASHBOARD) : la query `DupSrcWidgets` utilise désormais
  `position { ${PAGE_LAYOUT_WIDGET_POSITION_FRAGMENT} }`. La création
  du widget dupliqué reconstruit `gridPosition` (REQUIRED par
  CreatePageLayoutWidgetInput) depuis le variant Grid quand applicable,
  ou un placeholder full-row + forward du variant union dans le champ
  `position` JSON (optional) sinon — Twenty conserve les sémantiques
  VerticalList / Canvas du layout source.

### Fixed — `twenty_page_layout_tab_add` rejeté par Twenty 2.1 quand `icon` est fourni

Découvert empiriquement le 2026-05-10 lors de la création d'un
dashboard "Pilotage Ataraxis" via l'agent OpenClaw. Twenty 2.1
distingue strictement `CreatePageLayoutTabInput` (4 champs : title /
position / pageLayoutId / layoutMode — **PAS de icon**) et
`UpdatePageLayoutTabInput` (4 champs : title / position / icon /
layoutMode). L'icon ne peut être set qu'en `update`, pas en `create`.

Le plugin v0.8.1 exposait `icon` dans `TabAddSchema` ET le passait
dans `createPageLayoutTab`, ce qui faisait échouer la mutation avec
`Field "icon" is not defined by type "CreatePageLayoutTabInput"`.

### Changed

- `src/tools/page-layouts.ts — twenty_page_layout_tab_add` :
  séquencement transparent en 2 étapes — `createPageLayoutTab` sans
  icon, puis `updatePageLayoutTab` pour set l'icon (uniquement quand
  l'agent en fournit un). Du point de vue de l'agent, c'est toujours
  un seul appel.
- `src/tools/page-layouts.ts — twenty_page_layout_duplicate` (cascade
  manuelle pour les non-DASHBOARD) : même séquencement appliqué.

### Fixed — `WidgetTypeSchema` ne whitelist que 5 types alors que Twenty 2.1 en supporte 19

Découvert empiriquement le 2026-05-10 lors d'une tentative de
configuration de `Livrable.summary` (RICH_TEXT) avec un widget natif
`FIELD_RICH_TEXT` (pattern Note.bodyV2 / Task.bodyV2). Le tool
`twenty_page_layout_widget_add` rejetait le type côté TypeBox avant
d'atteindre Twenty.

### Changed

- `src/tools/widget-schemas.ts` — `WidgetTypeSchema` étendu de 5 à
  **19 valeurs** : pré-existantes (GRAPH / RECORD_TABLE / IFRAME /
  STANDALONE_RICH_TEXT / VIEW) + 14 nouvelles natives Twenty 2.1
  (`FIELDS`, `FIELD`, `FIELD_RICH_TEXT`, `TIMELINE`, `TASKS`, `NOTES`,
  `FILES`, `EMAILS`, `CALENDAR`, `WORKFLOW`, `WORKFLOW_VERSION`,
  `WORKFLOW_RUN`, `FRONT_COMPONENT`, `EMAIL_THREAD`). Source : Twenty
  2.1 `__type(name: "WidgetType")` introspection.
- `src/tools/page-layouts.ts` — `PAGE_LAYOUT_WIDGET_FRAGMENT` enrichi
  pour exposer `position` et `configuration`. Position est un UNION
  de 3 variants (`PageLayoutWidgetGridPosition` pour GRID,
  `PageLayoutWidgetVerticalListPosition` pour VERTICAL_LIST,
  `PageLayoutWidgetCanvasPosition` pour CANVAS). Le fragment utilise
  des inline fragments GraphQL pour récupérer les fields spécifiques
  à chaque variant. `configuration` réutilise le
  `WIDGET_CONFIGURATION_FRAGMENT` existant qui couvrait déjà les 22
  types de configuration (rien à ajouter là).

### Notes

- v0.8.2 ne change AUCUN tool name ni signature. Pas de breaking.
  L'agent gagne juste la capacité de référencer + créer + lire les
  14 widgets natifs Twenty (notamment `FIELD_RICH_TEXT` pour les
  RICH_TEXT fields des fiches détail).
- Les configurations natives sans payload utile (CalendarConfiguration,
  EmailsConfiguration, NotesConfiguration, TasksConfiguration,
  TimelineConfiguration, FilesConfiguration, EmailThreadConfiguration,
  ViewConfiguration, WorkflowConfiguration, WorkflowRunConfiguration,
  WorkflowVersionConfiguration, FieldRichTextConfiguration) ne
  contiennent que `configurationType` — Twenty les configure par
  convention côté UI (ex. `FIELD_RICH_TEXT` prend automatiquement le
  premier RICH_TEXT field du model parent).

## [0.8.1] - 2026-05-09

### Fixed — `Type.Intersect` schemas rejected by OpenAI (regression in v0.8.0)

Two list-columns tools (`twenty_list_columns_set_order` and
`twenty_list_columns_set_visibility`) used `Type.Intersect([Target,
Object{...}])` from TypeBox to compose their parameter schema. TypeBox's
`Intersect` emits `allOf` at the top level of the resulting JSON
schema. OpenAI's function-tool format **rejects** any function whose
top-level schema uses `allOf` / `oneOf` / `anyOf` / `enum` / `not` —
the agent surfaced this as:

```
LLM request rejected: Invalid schema for function
'twenty_list_columns_set_order': schema must have type 'object' and
not have 'oneOf'/'anyOf'/'allOf'/'enum'/'not' at the top level.
```

In production this pinned the agent's event loop in a retry loop
(`eventLoopDelayMaxMs=7574.9` observed on the gateway).

### Changed

- `src/tools/list-columns.ts` — both schemas rewritten as flat
  `Type.Object({...})` with `viewId` + `objectMetadataId` inlined
  alongside the tool-specific fields. No behavioral change.
- `test/tools/openai-schema-compat.test.ts` — new regression-guard
  test that walks every registered tool from every builder
  (148+ tools across 23 builders) and asserts the parameter schema
  is `type: "object"` with no `allOf` / `oneOf` / `anyOf` / `enum` /
  `not` at the top level. Catches future regressions of this exact
  shape at CI time.

### Notes

- 74/74 tests pass after the fix (73 + 1 new schema-compat guard).
- No behavioral change to the tools' contracts — the agent uses them
  identically.
- v0.8.0 is **rendered unusable for these two tools** by the OpenAI
  API rejection. Operators on v0.8.0 should upgrade immediately.

## [0.8.0] - 2026-05-09

### Added — Surface 3: Field configuration (5 tools)

PR4 layers ergonomic wrappers on `updateOneField` so the agent can
manipulate field-level settings atomically without crafting the full
`UpdateFieldInput` payload:

- `twenty_metadata_field_options_set` — replace SELECT / MULTI_SELECT
  options atomically (full set; missing entries removed). Each option
  carries label / value / color / position / isDefault.
- `twenty_metadata_field_settings_set` — replace the type-specific
  `settings` JSON. Examples:
  - CURRENCY → `{ currencyCode: "EUR", decimals: 2 }`
  - RATING → `{ maxValue: 5 }`
  - NUMBER → `{ format: "percentage", decimals: 0 }`
  - RICH_TEXT → `{ toolbar: ['bold','italic',...] }`
  - RELATION → `{ onDelete: "CASCADE" | "SET_NULL" | "RESTRICT" }`
- `twenty_metadata_field_default_set` — set or clear the field's
  `defaultValue` JSON.
- `twenty_metadata_field_constraints_set` — toggle isNullable /
  isUnique / isUIReadOnly / isActive.
- `twenty_metadata_field_relation_settings_set` — convenience tool
  for RELATION-specific settings (onDelete + optional inverseLabel).

Every Surface 3 tool is approval-gated by default (field metadata
mutations affect every record of the parent object).

### Added — Surface 5: Roles & Permissions (13 tools)

PR5 opens up Twenty's RBAC graph. Roles, principal assignments, and
the four upsert mutations (object permissions, field permissions,
permission flags, row-level predicates) are now reachable from the
agent — without leaving the safety net of approval gates.

Tools:

- **Role catalogue (5)**: `twenty_roles_list`, `twenty_role_get`
  (joined permissions), `twenty_role_create`, `twenty_role_update`,
  `twenty_role_delete`.
- **Assignments (4)**: `twenty_role_assign_workspace_member`
  (human user), `twenty_role_assign_agent` (LLM principal),
  `twenty_role_revoke_agent`, `twenty_role_assign_api_key`.
- **Permission upserts (4)**: `twenty_role_object_permissions_upsert`
  (per-object canRead / canUpdate / canSoftDelete / canDestroy),
  `twenty_role_field_permissions_upsert` (per-field canRead /
  canUpdateFieldValue), `twenty_role_permission_flags_upsert`
  (replace the 25-flag set: `ROLES`, `DATA_MODEL`, `SECURITY`,
  `WORKFLOWS`, `VIEWS`, `LAYOUTS`, `BILLING`, `AI_SETTINGS`, `AI`,
  ...), `twenty_role_row_level_predicates_upsert` (conditional
  AND/OR predicate trees scoped to a role + object pair).

Every write tool is **approval-gated CRITICAL** — wrong permissions
have workspace-wide blast radius.

### Added — Surface 6: Workspace settings (2 tools)

PR6 exposes the `currentWorkspace` read + the powerful
`runWorkspaceMigration` mutation:

- `twenty_workspace_get` — read settings (subdomain, displayName,
  auth providers, 2FA enforcement, retention windows, **AI settings**:
  fastModel, smartModel, aiAdditionalInstructions, enabledAiModelIds,
  useRecommendedModels). Distinct from `twenty_workspace_info` which
  lists metadata objects.
- `twenty_workspace_run_migration` — apply a `WorkspaceMigrationInput`
  atomically (CREATE_OBJECT / ALTER_OBJECT / DELETE_OBJECT /
  CREATE_FIELD / ... in a single transaction). **Approval-gated
  CRITICAL** — irreversible at the schema level.

`twenty_workspace_update` was scoped OUT of v0.8.0 after live testing
on Twenty 2.1 returned `FORBIDDEN — This endpoint requires a user
context. API keys are not supported.` Operators must edit workspace
settings through the Twenty UI; the tool will be reintroduced when /
if Twenty exposes a user-impersonation flow for API keys (or when
Twenty's policy on this endpoint changes).

`twenty_workspace_logo_upload` was also scoped out (multipart file
upload requires binary context the LLM does not have a path to;
operators upload via the UI).

### Approvals summary

`DEFAULT_APPROVAL_REQUIRED` grows from 35 (alpha.3) to **52 entries**
in v0.8.0:
- +5 Surface 3 (every field-config wrapper)
- +11 Surface 5 (every role write — create/update/delete + 4
  assignments + 4 upserts)
- +1 Surface 6 (run_migration; updateWorkspace was scoped out)

### Tool count summary

| Layer | Count |
|---|---|
| v0.7.4 carry-over | 86 (minus 12 dashboard tools removed in PR3) = **74** |
| Surface 1 — Views | 32 |
| Surface 2 — Page Layouts | 17 |
| Surface 3 — Field config | 5 |
| Surface 4 — List columns | 5 |
| Surface 5 — Roles + Permissions | 13 |
| Surface 6 — Workspace settings | 2 |
| **Total v0.8.0** | **148 tools** |

### Notes

- All Twenty 2.1 GraphQL input types referenced by Surfaces 3 / 5 / 6
  (`UpdateFieldInput`, `CreateRoleInput`, `UpsertObjectPermissionsInput`,
  `UpsertFieldPermissionsInput`, `UpsertPermissionFlagsInput`,
  `UpsertRowLevelPermissionPredicatesInput`, `UpdateWorkspaceInput`,
  `WorkspaceMigrationInput`) were introspected via `__type(name:...)`
  before mutation — every shape used by the plugin matches the schema
  as of 2026-05-09.
- v0.8.0 is the FINAL release of the v0.8.x line. Subsequent minor
  releases will refine surfaces / chase Twenty's schema drift /
  introduce additional ergonomic tools (e.g. `twenty_view_field_groups_*`
  helpers, automatic position renumbering on tab destroy, ...).

## [0.8.0-alpha.3] - 2026-05-09

### BREAKING — Removed every `twenty_dashboard_*` tool (replaced by generic `twenty_page_layout_*`)

PR3 unifies Twenty's PageLayout surface into a single generic vocabulary
that covers every layout type — `DASHBOARD`, `RECORD_PAGE` (record
detail), `RECORD_INDEX` (object index), `STANDALONE_PAGE`. The 12
v0.7.x dashboard-specific tools are **DELETED outright**, no
deprecation alias kept (per the v0.8.0 design directive: zero dead
code).

Removed tools (operators must rename in their workflows / SKILL.md):

| v0.7.x | v0.8.0-alpha.3 |
|---|---|
| `twenty_dashboards_list` | `twenty_page_layouts_list` (filter by `pageLayoutType: "DASHBOARD"`) |
| `twenty_dashboard_get` | `twenty_page_layout_get` (returns the `dashboards` workspace record alongside the layout when applicable) |
| `twenty_dashboard_create_complete` | `twenty_page_layout_create_complete` (`type: "DASHBOARD"` orchestrates the workspace record automatically) |
| `twenty_dashboard_duplicate` | `twenty_page_layout_duplicate` (DASHBOARD path delegates to Twenty's native `duplicateDashboard`; non-DASHBOARD paths replay create+tabs+widgets) |
| `twenty_dashboard_delete` | `twenty_page_layout_destroy` (also soft-deletes the matching `/rest/dashboards` record for DASHBOARD layouts) |
| `twenty_dashboard_replace_layout` | `twenty_page_layout_replace_with_tabs` |
| `twenty_dashboard_tab_add/_update/_delete` | `twenty_page_layout_tab_add/_update/_destroy` |
| `twenty_dashboard_widget_add/_update/_delete/_data` | `twenty_page_layout_widget_add/_update/_destroy/_data` |

The renames + DASHBOARD record orchestration work transparently for
DASHBOARD layouts — the agent does not have to manage the
`/rest/dashboards` workspace record itself.

### Added — Surface 2: Page Layouts (17 tools)

Beyond the rename, PR3 extends the surface with capabilities the v0.7.x
dashboard-only tools could not address:

- **Every PageLayoutType is reachable** — RECORD_PAGE (record detail
  layouts that the agent could not configure before), RECORD_INDEX
  (object index page customisation), STANDALONE_PAGE (workspace pages
  not bound to an object). Direct fix for the missing-Mission-layout
  bug logged on 2026-05-09.
- **`twenty_page_layout_reset_to_default`** + tab/widget reset — wraps
  Twenty's `resetPageLayoutToDefault` family, useful when an
  experiment leaves a layout in a broken state.
- **8 top-level + 4 tab + 5 widget tools = 17 total**:

| Tool family | Tools |
|---|---|
| Layout (8) | list, get, create, update, destroy, reset_to_default, duplicate, replace_with_tabs, create_complete |
| Tab (4) | add, update, destroy, reset_to_default |
| Widget (5) | add, update, destroy, reset_to_default, data |

`DEFAULT_APPROVAL_REQUIRED` grows by **3 entries** net: removes 4 v0.7.x
dashboard gates, adds 7 page-layout gates (every `*_destroy` +
`*_reset_to_default` + `replace_with_tabs`). Total: **35 gated tools**.

### Notes

- `widget-config-fragment.ts` and `widget-schemas.ts` are kept as-is
  (shared GraphQL fragment + TypeBox schema for widget grid positions
  and widget types).
- The deleted `test/tools/dashboards.test.ts` was rewritten as
  `test/tools/page-layouts.test.ts` covering the catalogue, the
  DASHBOARD-create cascade with `/rest/dashboards` orchestration, and
  the widget-data dispatcher.
- Operators upgrading from 0.7.x must regenerate their `SKILL.md`
  references (the cmux skills-snapshot pipeline picks up the new
  tool names automatically; no manual sync needed beyond the
  pipeline's 30-min cadence).

## [0.8.0-alpha.2] - 2026-05-09

### Added — Surface 4: List columns (5 tools)

PR2 layers ergonomic wrappers on top of the Surface 1 ViewField
primitives so the agent can reason in column / list vocabulary instead
of descending to ViewField mutations:

- `twenty_list_columns_get` — return the ordered list of columns of a
  TABLE view, with each column's name / label / type / visibility /
  position / size joined from FieldMetadata. Auto-resolves the default
  INDEX TABLE view when called with `objectMetadataId` only.
- `twenty_list_columns_set_order` — reorder columns by supplying field
  metadata UUIDs in the desired order. Issues one updateViewField per
  matching ViewField with positions 0, 1, 2, .... Skips unknown UUIDs
  (reported back).
- `twenty_list_columns_set_visibility` — bulk toggle (fieldMetadataId
  + isVisible) keyed by field, not by ViewField id.
- `twenty_list_column_set_size` — pixel width of a single column;
  `0` means "use Twenty's default for this field type".
- `twenty_list_columns_reset_default` — overwrite size + visibility +
  position on every column of a view (sets isVisible=true, size=0,
  renumbers positions). ViewFields are NOT destroyed and field
  metadata is untouched. **Approval-gated** (overwrites layout in one
  shot).

All five tools accept either an explicit `viewId` (must be `type =
TABLE`) or an `objectMetadataId` to auto-resolve the default INDEX
TABLE view. Mixing them is fine; passing neither errors out.

`DEFAULT_APPROVAL_REQUIRED` grows by one entry
(`twenty_list_columns_reset_default`) → 32 gated tools total.

### Notes

- Surface 4 explicitly does NOT cover record-detail layouts (those go
  through Surface 2 / PageLayout, shipped in `v0.8.0-alpha.3`) nor
  KANBAN cards / CALENDAR positioning (Surface 1 handles those via
  ViewGroup + ViewSort directly).

## [0.8.0-alpha.1] - 2026-05-09

### Added — Surface 1: Views (32 tools)

PR1 of the v0.8.0 plugin extension opens up Twenty's `View` /
`ViewField` / `ViewFieldGroup` / `ViewFilter` / `ViewFilterGroup` /
`ViewSort` / `ViewGroup` graph to OpenClaw agents. The agent can now
build, modify, and inspect saved layouts on any object — list, kanban,
calendar, and embedded widget views — without going through the Twenty
UI.

Every entity exposes both **soft delete** (`*_delete`, reversible —
sets `deletedAt`, restorable through Twenty's UI trash) and **hard
delete** (`*_destroy`, irreversible). Hard destroys are approval-gated
by default; soft deletes are not.

New tools (all backed by Twenty's `/metadata` GraphQL endpoint):

- **View top-level (7)**: `twenty_views_list`, `twenty_view_get`
  (joins fields/filters/sorts/groups in one call), `twenty_view_create`,
  `twenty_view_update`, `twenty_view_delete` (soft),
  `twenty_view_destroy` (hard, gated), `twenty_view_duplicate` (clones
  the view + optionally its children).
- **ViewField (5)**: `twenty_view_field_add`, `_update`, `_delete`
  (soft), `_destroy` (hard, gated), `twenty_view_fields_reorder`
  (helper that assigns sequential positions from a UUID array).
- **ViewFieldGroup (4)**: `_add`, `_update`, `_delete` (soft),
  `_destroy` (hard, gated) — visual blocks on record-detail views.
- **ViewFilter (4)**: `_add`, `_update`, `_delete` (soft), `_destroy`
  (hard, gated) — supports all 16 Twenty 2.1 operands.
- **ViewFilterGroup (4)**: `_add`, `_update`, `_delete` (soft),
  `_destroy` (hard, gated) — logical AND/OR groupings; nestable.
- **ViewSort (4)**: `_add`, `_update`, `_delete` (soft), `_destroy`
  (hard, gated).
- **ViewGroup (4)**: `_add`, `_update`, `_delete` (soft), `_destroy`
  (hard, gated) — kanban columns.

Seven new approval-gated tools added to `DEFAULT_APPROVAL_REQUIRED`
(every `*_destroy` mutation): `twenty_view_destroy`,
`twenty_view_field_destroy`, `twenty_view_field_group_destroy`,
`twenty_view_filter_destroy`, `twenty_view_filter_group_destroy`,
`twenty_view_sort_destroy`, `twenty_view_group_destroy`.

### BREAKING — `serverUrl` is now required

The plugin no longer ships a `DEFAULT_SERVER_URL`. Operators MUST set
`plugins.entries.twenty-openclaw.config.serverUrl` to their Twenty
instance URL (e.g. `https://crm.example.com`). `resolveConfig()` throws
when `serverUrl` resolves to an empty string after env substitution —
this surfaces as a plugin registration error rather than silently
falling back to a hostname that cannot exist in the operator's network.

Migration path:
- Add `"serverUrl": "https://your-twenty-instance.example.com"` (or a
  `${TWENTY_SERVER_URL}` substitution) to your plugin config before
  upgrading.
- The manifest's `configSchema` now lists `serverUrl` in `required`.

### Changed — agnostic codebase

Removed every reference to specific deployment domains from the source
code so the plugin is environment-neutral:
- `src/config.ts` — `DEFAULT_SERVER_URL` constant removed.
- `openclaw.plugin.json` — `default` removed from `serverUrl` property.
- `src/tools/metadata.ts`, `src/tools/dashboard-widgets.ts` — comments
  rewritten to reference "a Twenty 2.1 instance" generically.
- `README.md` — examples use `https://crm.example.com`.
- `test/config.test.ts` — uses `https://crm.test.local` for the mock.

`CHANGELOG.md` historical entries are preserved verbatim (they are
dated records, not configuration).

### Notes

- 54/54 existing tests still pass after the refactor (4 of the
  pre-existing test files needed minor adjustments for the new
  `serverUrl` requirement); 6 new tests added in
  `test/tools/views.test.ts` validate the catalogue + GraphQL request
  shapes for the new tools. Total: 60/60 ✓.
- All Twenty 2.1 GraphQL input types (`UpdateView*Input`,
  `DeleteView*Input`, `DestroyView*Input`) were introspected via
  `__type(name: ...)` queries before writing the mutations — every
  shape used by the plugin matches the schema as of 2026-05-09.
- This is `v0.8.0-alpha.1`, a pre-release for local testing. PR1
  ships **only Surface 1**. The full v0.8.0 release tags when Surfaces
  2 (Page Layouts), 3 (Field config), 4 (List columns), 5 (Roles +
  Permissions), and 6 (Workspace settings) are merged in subsequent
  PRs (`v0.8.0-alpha.2`, `-alpha.3`, ..., final `v0.8.0`).

## [0.7.4] - 2026-05-03

### Changed — compat aligned to 2026.5.0

After empirical validation that the plugin manifest fields
(`contracts.tools`, `activation.onStartup`, `toolMetadata`) we
introduced in 0.7.0–0.7.3 are 2026.5.x-specific, we now declare
the minimum supported OpenClaw version as 2026.5.0:

- `package.json#openclaw.compat`:
  `pluginApi: ">=2026.4.0"` → `">=2026.5.0"`,
  `minGatewayVersion: "2026.4.0"` → `"2026.5.0"`.
- `peerDependencies.openclaw` and `devDependencies.openclaw`:
  `">=2026.4.0"` → `">=2026.5.0"`.

### Notes

- No code change in `src/`. No manifest content change.
- 52/52 tests still pass.
- Operators on OpenClaw 2026.4.x must keep `@lacneu/twenty-openclaw@0.7.0`
  (last release without the strict `contracts.tools` enforcement
  contract). 2026.5.0+ users should be on 0.7.4.
- Reminder: OpenClaw 2026.5.2 has a separate per-agent inventory bug
  (issue #76598, fix in `a3b94f39109d` pending in 2026.5.3) that
  prevents twenty's tools from appearing in the agent's callable
  inventory. This release does not work around that — the plugin is
  ready and registered correctly, but the upstream fix is still
  required for end-to-end functionality.

## [0.7.3] - 2026-05-03

### Added — `activation.onStartup: true` in the manifest

OpenClaw 2026.5.2 introduces (or hardens) a manifest-driven activation
gate. Plugins that do NOT declare `activation.onStartup: true` are
loaded into the plugin registry and `api.registerTool(...)` calls
succeed at runtime — the boot log shows
`twenty-openclaw: ready — 86 tool(s) registered` — but those
registered tools never propagate into the per-agent effective tool
inventory resolved by `tools-effective-inventory.ts`. Operators see:

- `tools.alsoAllow: ["<tool_name>"]` entries logged as
  "unknown entries (...) won't match any tool unless the plugin is
  enabled" even though the plugin is `enabled: true` in config.
- The agent reports 0 callable `twenty_*` tools while the plugin
  catalogue, `plugins inspect twenty-openclaw --runtime --json`,
  and the gateway boot log all confirm 86 registered tools.

Empirical observation on instance jerome (2026-05-03): patching the
installed manifest in-container with `activation.onStartup: true`
resolved the warning in some boot iterations but did not restore
agent visibility — confirming that the manifest must ship the field
declaratively from the published package, not via post-install
mutation.

### Why skip 0.7.2

`@lacneu/twenty-openclaw@0.7.2` was published outside the repo with
the same content as 0.7.1 plus a manifest patch experiment that
this release supersedes. The 0.7.3 history continues from 0.7.1 in
git: `version` field bumped, `activation` block added, no other
manifest content change.

### Migration

For instance owners on `@lacneu/twenty-openclaw@0.7.x`:

1. `openclaw plugins install @lacneu/twenty-openclaw@0.7.3 --force`
2. Restart the gateway container.
3. Verify in the boot log:
   `twenty-openclaw: ready — 86 tool(s) registered, 24 approval-gated`.
4. Verify in `openclaw plugins inspect twenty-openclaw --runtime --json`:
   `"activated": true` AND `"activationSource"` should now reflect
   `"manifest"` (rather than only `"explicit"` from config).
5. Test from an agent: `twenty_companies_list` (or any other
   `twenty_*` tool) should now appear in the agent inventory.

### Notes

- No code change in `src/`. Manifest-only.
- `tools.alsoAllow` listing the 86 individual tool names should no
  longer be required once the plugin advertises `activation.onStartup`
  declaratively. To be confirmed by `tools.alsoAllow` simplification
  after deployment.

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
