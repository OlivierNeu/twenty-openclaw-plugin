// Live smoke test for the P8 workflow tools.
//
// Without the `WORKFLOWS` permission flag, only standard CRUD tools work:
//   - twenty_workflows_list
//   - twenty_workflow_create_complete (REST-only path: workflow + version)
//   - twenty_workflow_get
//   - twenty_workflow_delete
//   - twenty_workflow_runs_list
//   - twenty_workflow_run_get (when there are runs)
//
// With the WORKFLOWS perm, the script also exercises:
//   - twenty_workflow_step_add (after create_complete)
//   - twenty_workflow_version_activate
//   - twenty_workflow_run + twenty_workflow_run_get
//
// Reads creds from `.env`. Exits 0 on success, non-zero with stack on
// failure.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { TwentyClient } from "../dist/twenty-client.js";
import { resolveConfig } from "../dist/config.js";
import { buildWorkflowTools } from "../dist/tools/workflows.js";
import { buildWorkflowRunTools } from "../dist/tools/workflow-runs.js";
import { buildWorkflowStepTools } from "../dist/tools/workflow-steps.js";
import { buildWorkflowVersionTools } from "../dist/tools/workflow-versions.js";

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

const wfTools = Object.fromEntries(
  buildWorkflowTools(client).map((t) => [t.name, t]),
);
const wfvTools = Object.fromEntries(
  buildWorkflowVersionTools(client).map((t) => [t.name, t]),
);
const wfsTools = Object.fromEntries(
  buildWorkflowStepTools(client).map((t) => [t.name, t]),
);
const wfrTools = Object.fromEntries(
  buildWorkflowRunTools(client).map((t) => [t.name, t]),
);

// Twenty masks WORKFLOWS-perm errors in several shapes:
//   - GraphQL: { errors: [{ message: "Forbidden resource", code: "FORBIDDEN" }] }
//   - REST:    400 { error: "Error", code: "FORBIDDEN", messages: ["Method not allowed."] }
//   - REST:    400 messages: ["Method not allowed."]  (no explicit code)
const FORBIDDEN_RE = /Forbidden resource|FORBIDDEN|Method not allowed/i;

async function run(tool, params, { tolerateForbidden = false } = {}) {
  const t0 = Date.now();
  const r = await tool.execute("smoke", params);
  const dt = Date.now() - t0;
  if (r.details.status !== "ok") {
    if (tolerateForbidden && FORBIDDEN_RE.test(r.details.error ?? "")) {
      console.log(
        `⚠  ${tool.name} (${dt}ms) — Forbidden (WORKFLOWS perm missing, expected)`,
      );
      return null;
    }
    console.error(`✗ ${tool.name} (${dt}ms) — ${r.details.error}`);
    process.exit(1);
  }
  console.log(`✓ ${tool.name} (${dt}ms)`);
  return r.details.data;
}

const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");
const WF_NAME = `[OpenClaw P8 smoke] ${TIMESTAMP}`;

console.log(`Smoke target: ${env.TWENTY_SERVER_URL}`);
console.log(`Workspace:    ${env.TWENTY_WORKSPACE_ID}`);
console.log(`Workflow:     "${WF_NAME}"`);
console.log();

// 1. List existing workflows (smoke check on read).
const list = await run(wfTools.twenty_workflows_list, {});
console.log(`  → ${list.count} workflow(s) currently in workspace`);

// 2. Create a complete workflow. Twenty's `createWorkflowVersion` REST
//    endpoint requires WORKFLOWS perm (returns FORBIDDEN masked as
//    "Method not allowed" without it). The Workflow record itself
//    succeeds — so on a no-perm key we may end up with an orphan.
let workflowId = null;
let versionId = null;
const created = await run(
  wfTools.twenty_workflow_create_complete,
  {
    name: WF_NAME,
    trigger: {
      type: "MANUAL",
      settings: {
        outputSchema: {},
      },
    },
    steps: [
      {
        id: "00000000-1111-2222-3333-444444444444",
        name: "Smoke step",
        type: "EMPTY",
        valid: true,
        settings: {
          input: {},
          outputSchema: {},
          errorHandlingOptions: {
            retryOnFailure: { value: false },
            continueOnFailure: { value: false },
          },
        },
      },
    ],
  },
  { tolerateForbidden: true },
);

if (created) {
  workflowId = created.workflowId;
  versionId = created.workflowVersionId;
  console.log(
    `  → workflowId=${workflowId} versionId=${versionId} stepCount=${created.stepCount}`,
  );

  // 3. Read it back.
  const got = await run(wfTools.twenty_workflow_get, { workflowId });
  console.log(`  → ${got.versionCount} version(s), ${got.runCount} run(s)`);

  // 4. version_get_current.
  const cur = await run(wfvTools.twenty_workflow_version_get_current, {
    workflowId,
  });
  console.log(
    `  → current source=${cur.source}, version status=${cur.version?.status ?? "n/a"}`,
  );
} else {
  console.log(
    `  → create_complete forbidden — recovering orphan workflow record(s)`,
  );
  // Recover any orphan workflow that was created before the FORBIDDEN
  // version cascade failed.
  const stillThere = await run(wfTools.twenty_workflows_list, {});
  const orphan = stillThere.workflows.find((w) => w.name === WF_NAME);
  if (orphan) {
    workflowId = orphan.id;
    console.log(`  → recovered orphan workflowId=${workflowId}`);
  }
}

if (versionId) {
  // 5. Try a step_add — requires WORKFLOWS perm. Tolerate forbidden.
  const stepAdd = await run(
    wfsTools.twenty_workflow_step_add,
    { workflowVersionId: versionId, stepType: "EMPTY" },
    { tolerateForbidden: true },
  );
  if (stepAdd) {
    console.log(`  → step_add OK — WORKFLOWS perm is granted`);
  }

  // 6. Try activate. Tolerate forbidden.
  const activated = await run(
    wfvTools.twenty_workflow_version_activate,
    { workflowVersionId: versionId },
    { tolerateForbidden: true },
  );
  if (activated) {
    console.log(`  → version_activate OK`);

    // 7. If activated, try a run.
    const ran = await run(
      wfrTools.twenty_workflow_run,
      { workflowVersionId: versionId },
      { tolerateForbidden: true },
    );
    if (ran) {
      console.log(`  → workflow_run OK, runId=${ran.workflowRunId}`);
      await new Promise((r) => setTimeout(r, 2000));
      const runDetail = await run(wfrTools.twenty_workflow_run_get, {
        workflowRunId: ran.workflowRunId,
      });
      console.log(
        `  → run status=${runDetail.run.status}, ` +
          `durationMs=${runDetail.run.durationMs ?? "?"}, ` +
          `stepStatusCounts=${JSON.stringify(runDetail.stepStatusCounts)}`,
      );
    }
  }
}

// 8. List runs (read, no perm needed).
if (workflowId) {
  const runs = await run(wfrTools.twenty_workflow_runs_list, {
    workflowId,
    limit: 5,
  });
  console.log(`  → ${runs.count} run(s) for this workflow`);

  // 9. Cleanup — workflow_delete.
  await run(wfTools.twenty_workflow_delete, { workflowId });
}

console.log();
console.log("✓ P8 smoke test complete — workflow lifecycle exercised.");
