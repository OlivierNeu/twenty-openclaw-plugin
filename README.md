# `@lacneu/twenty-openclaw`

Twenty CRM REST API plugin for [OpenClaw](https://openclaw.ai). Lets an
OpenClaw agent read and (eventually) modify Twenty workspaces — People,
Companies, Opportunities, Notes, Tasks — with workspace whitelisting,
approval gating on destructive operations, an optional global read-only
switch, and a small set of opinionated business helpers (dedup, enrich,
bulk import).

> **Status:** P0 + P1 bootstrap. The plugin currently ships **one** read-
> only tool (`twenty_workspace_info`). The remaining ~29 domain tools
> arrive in subsequent phases — see the [Roadmap](#roadmap).

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
| `approvalRequired` | string[] | 10 destructive tool names | Triggers an approval prompt via the `before_tool_call` hook. **Not enforced yet** — wired in P3. |
| `readOnly` | boolean | `false` | When true, every mutating tool is rejected at the plugin layer before any HTTP call. |
| `logLevel` | string | `info` | `debug` includes request bodies (be mindful of PII). |

## Tools

### Currently shipped (P1)

| Tool | Description | Mutates? |
|---|---|---|
| `twenty_workspace_info` | List all metadata objects (standard + custom) of the configured workspace. Returns server URL, object counts, and per-object summary (name, label, fields count, isCustom, isActive, isSystem). | No |

### Planned (P2 — domain CRUD)

| Tool | Description |
|---|---|
| `twenty_people_search` / `_get` / `_create` / `_update` / `_delete` | People CRUD with cursor pagination. |
| `twenty_companies_search` / `_get` / `_create` / `_update` / `_delete` | Companies CRUD. |
| `twenty_opportunities_search` / `_get` / `_create` / `_update` / `_delete` | Opportunities CRUD with stage filters. |
| `twenty_notes_search` / `_get` / `_create` / `_update` / `_delete` | Notes CRUD against any record. |
| `twenty_tasks_search` / `_get` / `_create` / `_update` / `_delete` | Tasks CRUD with status + due date filters. |
| `twenty_activities_*` | Calls, meetings, message threads. |

### Planned (P3 — gating)

- `before_tool_call` approval hook driven by `approvalRequired`.

### Planned (P4 — business helpers)

- `twenty_enrich` — enrich a Person/Company from public data sources.
- `twenty_dedup_*` — find and merge duplicates.
- `twenty_find_similar` — semantic search across records.
- `twenty_bulk_import_csv` / `twenty_bulk_delete` — bulk operations.

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
  script, CI/Release workflows. ✅ *(this release)*
- **P2** — domain CRUD tools (people, companies, opportunities, notes,
  tasks, activities). 🟡 *(next)*
- **P3** — approval gating via `before_tool_call`. 🟡
- **P4** — business helpers (enrich, dedup, find_similar, bulk). 🟡

## License

MIT — see [LICENSE](./LICENSE).
