# `@lacneu/twenty-openclaw`

Twenty CRM REST API plugin for [OpenClaw](https://openclaw.ai). Lets an
OpenClaw agent read and (eventually) modify Twenty workspaces — People,
Companies, Opportunities, Notes, Tasks — with workspace whitelisting,
approval gating on destructive operations, an optional global read-only
switch, and a small set of opinionated business helpers (dedup, enrich,
bulk import).

> **Status:** P0 + P1 + P2 + P3. The plugin currently ships:
>
> - 1 introspection tool (`twenty_workspace_info`)
> - 9 read tools (list/get on People, Companies, Opportunities, Notes, Tasks)
> - 1 cross-record activities tool (`twenty_activities_list_for`)
> - **15 write tools** — `create`/`update`/`delete` on the same five entities
> - **`before_tool_call` approval hook** gating every destructive operation
>
> P4 business helpers (dedup, enrich, bulk import) are not yet shipped —
> see the [Roadmap](#roadmap).

---

## Overview

| Field | Value |
|---|---|
| Plugin id | `twenty-openclaw` |
| npm package | `@lacneu/twenty-openclaw` |
| OpenClaw compat | `pluginApi >= 2026.4.0`, `minGatewayVersion >= 2026.4.0` |
| License | MIT |
| Tools prefix | `twenty_*` |

The plugin talks to the Twenty REST API (`/rest/...`) using a single API
key sent as `Authorization: Bearer <key>`. It refuses to call any
workspace UUID that isn't in `allowedWorkspaceIds`.

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
            "twenty_custom_object_delete",
            "twenty_field_delete"
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
| `approvalRequired` | string[] | 10 destructive tool names | Triggers an approval prompt via the `before_tool_call` hook. Enforced as of P3 — defaults gate every `*_delete`. |
| `readOnly` | boolean | `false` | When true, every mutating tool is rejected at the plugin layer before any HTTP call. |
| `logLevel` | string | `info` | `debug` includes request bodies (be mindful of PII). |

## Tools

### Currently shipped

| Tool | Description | Mutates? |
|---|---|---|
| `twenty_workspace_info` | List all metadata objects (standard + custom) of the configured workspace. | No |
| `twenty_people_list` / `_get` | List + fetch-by-id People with cursor pagination. | No |
| `twenty_people_create` | Create a Person (`name`, `emails`, `jobTitle`, `city`, `companyId`). | Yes |
| `twenty_people_update` | Partial PATCH on a Person by UUID. | Yes |
| `twenty_people_delete` | Soft-delete a Person (`deletedAt` set, recoverable). Approval-gated. | Yes |
| `twenty_companies_list` / `_get` | List + fetch-by-id Companies. | No |
| `twenty_companies_create` / `_update` | Create / partial-update a Company. | Yes |
| `twenty_companies_delete` | Soft-delete a Company. Approval-gated. | Yes |
| `twenty_opportunities_list` / `_get` | List + fetch-by-id Opportunities. | No |
| `twenty_opportunities_create` / `_update` | Create / partial-update an Opportunity. | Yes |
| `twenty_opportunities_delete` | Soft-delete an Opportunity. Approval-gated. | Yes |
| `twenty_notes_list` | List Notes. (Use `twenty_activities_list_for` for record-attached notes.) | No |
| `twenty_notes_create` / `_update` | Create / partial-update a Note. | Yes |
| `twenty_notes_delete` | Soft-delete a Note. Approval-gated. | Yes |
| `twenty_tasks_list` | List Tasks. (Use `twenty_activities_list_for` for record-attached tasks.) | No |
| `twenty_tasks_create` / `_update` | Create / partial-update a Task. | Yes |
| `twenty_tasks_delete` | Soft-delete a Task. Approval-gated. | Yes |
| `twenty_activities_list_for` | Cross-record timeline (notes + tasks) attached to a Person/Company/Opportunity. | No |

**Soft-delete contract.** All `*_delete` tools issue
`DELETE /rest/<entity>/{id}?soft_delete=true`. The Twenty OpenAPI default is
HARD delete (`soft_delete=false`); this plugin overrides that explicitly so
records remain in the database with a `deletedAt` timestamp and are
recoverable through the Twenty UI or a future `twenty_<entity>_restore`
tool. Hard-delete is intentionally not exposed in this release.

### Planned (P4 — business helpers)

- `twenty_enrich` — enrich a Person/Company from public data sources.
- `twenty_dedup_*` — find and merge duplicates.
- `twenty_find_similar` — semantic search across records.
- `twenty_bulk_import_csv` / `twenty_bulk_delete` — bulk operations.
- `twenty_<entity>_restore` — undo a soft-delete.

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
  '["twenty_people_delete","twenty_companies_delete","twenty_opportunities_delete","twenty_notes_delete","twenty_tasks_delete"]' \
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
- **P3** — write tools (create/update/delete on the five entities) +
  `before_tool_call` approval gating on every destructive operation. ✅
  *(this release)*
- **P4** — business helpers (enrich, dedup, find_similar, bulk import,
  restore). 🟡

## License

MIT — see [LICENSE](./LICENSE).
