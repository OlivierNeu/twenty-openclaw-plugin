// Live smoke test for the P7 dashboard tools.
//
// Walks through the full lifecycle on a real Twenty server:
//   1. workspace_info — discover an objectMetadataId for KPIs
//   2. dashboard_create_complete — layout + record + tab + 1 KPI widget
//   3. dashboard_get — verify the join returned the widget
//   4. dashboard_widget_add — add a BAR_CHART widget
//   5. dashboard_widget_data — fetch the rendered data for the BAR
//   6. dashboard_widget_update — edit the bar chart title
//   7. dashboard_widget_delete + dashboard_delete — cleanup
//
// Reads creds from `.env` (preferred) or `.env.smoketest`.
// Exits 0 on success, non-zero with a stack on failure.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { TwentyClient } from "../dist/twenty-client.js";
import { resolveConfig } from "../dist/config.js";
import { buildWorkspaceTools } from "../dist/tools/workspace.js";
import { buildDashboardTools } from "../dist/tools/dashboards.js";
import { buildDashboardWidgetTools } from "../dist/tools/dashboard-widgets.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function parseDotEnv(path) {
  const text = readFileSync(path, "utf8");
  const out = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const dotenvPath = resolve(ROOT, ".env");
const templatePath = resolve(ROOT, ".env.smoketest");
const envPath = existsSync(dotenvPath) ? dotenvPath : templatePath;
const env = parseDotEnv(envPath);

for (const k of ["TWENTY_API_KEY", "TWENTY_SERVER_URL", "TWENTY_WORKSPACE_ID"]) {
  if (!env[k] || env[k].startsWith("replace-me")) {
    console.error(`Missing or placeholder ${k} in ${envPath}`);
    process.exit(2);
  }
}

const logger = {
  debug: () => {},
  info: () => {},
  warn: (m) => process.stderr.write(`[warn] ${m}\n`),
  error: (m) => process.stderr.write(`[error] ${m}\n`),
};

const config = resolveConfig({
  apiKey: env.TWENTY_API_KEY,
  serverUrl: env.TWENTY_SERVER_URL,
  allowedWorkspaceIds: [env.TWENTY_WORKSPACE_ID],
  defaultWorkspaceId: env.TWENTY_WORKSPACE_ID,
});
const client = new TwentyClient(config, logger);

const workspaceTools = Object.fromEntries(
  buildWorkspaceTools(client).map((t) => [t.name, t]),
);
const dashboardTools = Object.fromEntries(
  buildDashboardTools(client).map((t) => [t.name, t]),
);
const widgetTools = Object.fromEntries(
  buildDashboardWidgetTools(client).map((t) => [t.name, t]),
);

async function run(tool, params) {
  const t0 = Date.now();
  const r = await tool.execute("smoke", params);
  const dt = Date.now() - t0;
  if (r.details.status !== "ok") {
    console.error(`✗ ${tool.name} (${dt}ms) — ${r.details.error}`);
    process.exit(1);
  }
  console.log(`✓ ${tool.name} (${dt}ms)`);
  return r.details.data;
}

const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");
const DASH_TITLE = `OpenClaw P7 smoke ${TIMESTAMP}`;

console.log(`Smoke target: ${env.TWENTY_SERVER_URL}`);
console.log(`Workspace:    ${env.TWENTY_WORKSPACE_ID}`);
console.log(`Dashboard:    "${DASH_TITLE}"`);
console.log();

// 1. Discover an objectMetadataId via REST metadata list (workspace_info
//    strips ids; we need them).
const objectsResp = await client.request("GET", "/rest/metadata/objects");
const allObjects = objectsResp?.data?.objects ?? [];
const target =
  allObjects.find((o) => o.nameSingular === "opportunity") ??
  allObjects.find((o) => o.nameSingular === "person");
if (!target) {
  console.error("✗ no suitable target object (opportunity/person) found");
  process.exit(1);
}
console.log(
  `  → using ${target.namePlural} (id=${target.id}, ${target.fields?.length ?? "?"} fields)`,
);

// 2. Use the inline `fields` array returned with the object — Twenty
//    embeds all fields when fetched via /rest/metadata/objects/{id}.
const restMeta = await client.request(
  "GET",
  `/rest/metadata/objects/${target.id}`,
);
const fields = restMeta?.data?.object?.fields ?? target.fields ?? [];
const idField = fields.find((f) => f.name === "id");
const createdAtField = fields.find((f) => f.name === "createdAt");
if (!idField || !createdAtField) {
  console.error(
    `✗ missing \`id\` or \`createdAt\` field on ${target.namePlural}`,
  );
  process.exit(1);
}
console.log(
  `  → using id field (${idField.id}) for COUNT, createdAt (${createdAtField.id}) for groupBy`,
);

// 3. Create dashboard with one KPI widget.
const created = await run(dashboardTools.twenty_dashboard_create_complete, {
  title: DASH_TITLE,
  tabTitle: "Overview",
  widgets: [
    {
      title: `Total ${target.namePlural}`,
      type: "GRAPH",
      gridPosition: { row: 0, column: 0, rowSpan: 4, columnSpan: 6 },
      objectMetadataId: target.id,
      configuration: {
        configurationType: "AGGREGATE_CHART",
        aggregateFieldMetadataId: idField.id,
        aggregateOperation: "COUNT",
        label: "Total",
        suffix: ` ${target.namePlural}`,
      },
    },
  ],
});
const dashboardId = created.dashboardId;
const pageLayoutId = created.pageLayoutId;
const firstTabId = created.firstTabId;
console.log(
  `  → dashboardId=${dashboardId} pageLayoutId=${pageLayoutId} firstTabId=${firstTabId}`,
);

// 4. Read it back end-to-end.
const got = await run(dashboardTools.twenty_dashboard_get, { dashboardId });
console.log(
  `  → tabs=${got.tabs.length}, widgets[0]=${got.tabs[0]?.widgets?.length ?? 0}`,
);

// 5. Add a second BAR_CHART widget — group by createdBy.source if present,
//    fallback to a known field.
const bar = await run(widgetTools.twenty_dashboard_widget_add, {
  pageLayoutTabId: firstTabId,
  title: `${target.namePlural} by month`,
  type: "GRAPH",
  gridPosition: { row: 0, column: 6, rowSpan: 6, columnSpan: 6 },
  objectMetadataId: target.id,
  configuration: {
    configurationType: "BAR_CHART",
    aggregateFieldMetadataId: idField.id,
    aggregateOperation: "COUNT",
    primaryAxisGroupByFieldMetadataId: createdAtField.id,
    primaryAxisDateGranularity: "MONTH",
    layout: "VERTICAL",
  },
});
console.log(`  → barWidgetId=${bar.id}`);

// 6. Fetch the bar chart data.
const data = await run(widgetTools.twenty_dashboard_widget_data, {
  widgetId: bar.id,
});
console.log(`  → widget_data resolved configurationType=${data.configurationType}`);

// 7. Update the bar widget title.
const updated = await run(widgetTools.twenty_dashboard_widget_update, {
  id: bar.id,
  title: `${target.namePlural} by month (renamed)`,
});
console.log(`  → updated title=${updated.title}`);

// 8. Cleanup — widget delete (gated in production, but runtime here is
//    the smoke harness, which has no approval prompt). Then dashboard
//    delete (which destroys the layout + the remaining KPI widget).
await run(widgetTools.twenty_dashboard_widget_delete, { id: bar.id });
await run(dashboardTools.twenty_dashboard_delete, { dashboardId });

console.log();
console.log("✓ P7 smoke test complete — dashboard lifecycle exercised.");
