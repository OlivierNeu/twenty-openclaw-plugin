// Live smoke test for the Twenty REST endpoint behind `twenty_workspace_info`.
//
// Reads credentials from `.env.smoketest` at the repo root (gitignored
// when populated with real secrets — only the placeholder template is
// tracked) and exits 0 on success, 1 on tool failure, 2 on missing env.
//
// Usage:
//   1. Drop credentials in .env.smoketest:
//        TWENTY_API_KEY=...
//        TWENTY_SERVER_URL=https://crm.example.com
//        TWENTY_WORKSPACE_ID=<uuid>
//   2. npm run build
//   3. npm run smoke-test

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { TwentyClient } from "../dist/twenty-client.js";
import { resolveConfig } from "../dist/config.js";
import { buildWorkspaceTools } from "../dist/tools/workspace.js";

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
      (val.startsWith("\"") && val.endsWith("\"")) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const envPath = resolve(ROOT, ".env.smoketest");
const env = parseDotEnv(envPath);

const required = ["TWENTY_API_KEY", "TWENTY_SERVER_URL", "TWENTY_WORKSPACE_ID"];
for (const k of required) {
  if (!env[k] || env[k].startsWith("replace-me")) {
    console.error(`Missing or placeholder ${k} in ${envPath}`);
    process.exit(2);
  }
}

const logger = {
  debug: () => {},
  info: () => {},
  warn: (msg) => process.stderr.write(`[warn] ${msg}\n`),
  error: (msg) => process.stderr.write(`[error] ${msg}\n`),
};

const config = resolveConfig({
  apiKey: env.TWENTY_API_KEY,
  serverUrl: env.TWENTY_SERVER_URL,
  allowedWorkspaceIds: [env.TWENTY_WORKSPACE_ID],
  defaultWorkspaceId: env.TWENTY_WORKSPACE_ID,
});

const client = new TwentyClient(config, logger);
const tools = Object.fromEntries(
  buildWorkspaceTools(client).map((t) => [t.name, t]),
);
const tool = tools["twenty_workspace_info"];
if (!tool) {
  console.error("twenty_workspace_info tool not found in build output");
  process.exit(1);
}

const t0 = Date.now();
const result = await tool.execute("smoke-call", {});
const dt = Date.now() - t0;
const ok = result.details && result.details.status === "ok";

process.stdout.write(
  `${ok ? "✓" : "✗"} twenty_workspace_info  ${dt}ms\n`,
);
if (!ok) {
  process.stdout.write(
    `  error: ${String(result.details?.error ?? "unknown")}\n`,
  );
  process.exit(1);
}

const data = result.details.data ?? {};
process.stdout.write(
  `  workspaceUrl: ${data.workspaceUrl ?? "?"}\n` +
    `  objectCount: ${data.objectCount ?? 0}\n` +
    `  customObjectCount: ${data.customObjectCount ?? 0}\n`,
);

process.exit(0);
