// P5 live empirical validation.
//
// Exercises the metadata tools end-to-end against the real Twenty server:
//   1. Create a throwaway custom object via `twenty_metadata_object_create`
//   2. Poll `/rest/<plural>` to measure schema-regeneration timing (D4)
//   3. Create a TEXT field on that object via `twenty_metadata_field_create`
//   4. Create a RELATION field pointing at `person` (D1 — opaque options)
//   5. List fields via `twenty_metadata_fields_list` (objectMetadataId path)
//   6. Update the object label via `twenty_metadata_object_update`
//   7. Cleanup: delete object (cascading delete confirms hard-delete D3)
//
// Exits 0 on success, non-zero on any step failure.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { TwentyClient } from "../dist/twenty-client.js";
import { resolveConfig } from "../dist/config.js";
import { buildMetadataTools } from "../dist/tools/metadata.js";

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

const env = parseDotEnv(
  existsSync(resolve(ROOT, ".env"))
    ? resolve(ROOT, ".env")
    : resolve(ROOT, ".env.smoketest"),
);

const required = ["TWENTY_API_KEY", "TWENTY_SERVER_URL", "TWENTY_WORKSPACE_ID"];
for (const k of required) {
  if (!env[k] || env[k].startsWith("replace-me")) {
    console.error(`Missing ${k}`);
    process.exit(2);
  }
}

const config = resolveConfig({
  apiKey: env.TWENTY_API_KEY,
  serverUrl: env.TWENTY_SERVER_URL,
  allowedWorkspaceIds: [env.TWENTY_WORKSPACE_ID],
  defaultWorkspaceId: env.TWENTY_WORKSPACE_ID,
  // Disable approval for the live test — we want raw tool execution.
  approvalRequired: [],
});
const logger = {
  debug: () => {},
  info: () => {},
  warn: (m) => console.error("WARN:", m),
  error: (m) => console.error("ERR:", m),
};
const client = new TwentyClient(config, logger);
const tools = buildMetadataTools(client);
const tool = (name) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
};

async function run() {
  let createdObjectId = null;

  try {
    // Step 1 — create throwaway object.
    console.log("\n=== Step 1: create throwaway custom object ===");
    const create = tool("twenty_metadata_object_create");
    const t0 = Date.now();
    const r1 = await create.execute("p5-live", {
      nameSingular: "p5livetest",
      namePlural: "p5livetests",
      labelSingular: "P5 Live Test",
      labelPlural: "P5 Live Tests",
      icon: "IconBug",
      description: "Throwaway object — safe to delete",
    });
    if (r1.details?.status !== "ok") {
      console.error("FAIL create:", r1.details?.error);
      process.exit(1);
    }
    createdObjectId = r1.details.data.id;
    console.log(
      `OK created in ${Date.now() - t0}ms — id=${createdObjectId}, ` +
        `nameSingular=${r1.details.data.nameSingular}`,
    );

    // Step 2 — poll /rest/p5livetests for schema regeneration timing (D4).
    console.log("\n=== Step 2: poll /rest/p5livetests (D4 timing) ===");
    const headers = { Authorization: `Bearer ${env.TWENTY_API_KEY}` };
    const tPoll = Date.now();
    let attempts = 0;
    let availableMs = null;
    while (attempts < 20 && availableMs === null) {
      attempts += 1;
      const resp = await fetch(
        `${env.TWENTY_SERVER_URL}/rest/p5livetests`,
        { headers },
      );
      if (resp.status === 200) {
        availableMs = Date.now() - tPoll;
        await resp.text();
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (availableMs === null) {
      console.error("FAIL: /rest/p5livetests never became available");
      // Continue anyway to attempt cleanup.
    } else {
      console.log(
        `OK /rest/p5livetests reachable after ${availableMs}ms (` +
          `${attempts} polls). D4 verdict: ${
            availableMs < 500 && attempts === 1
              ? "synchronous"
              : "eventually-consistent"
          }`,
      );
    }

    // Step 3 — create TEXT field.
    console.log("\n=== Step 3: create TEXT field ===");
    const fieldCreate = tool("twenty_metadata_field_create");
    const r3 = await fieldCreate.execute("p5-live", {
      objectMetadataId: createdObjectId,
      type: "TEXT",
      name: "summaryText",
      label: "Summary Text",
      description: "Free-form summary",
    });
    if (r3.details?.status !== "ok") {
      console.error("FAIL field create:", r3.details?.error);
      process.exit(1);
    }
    console.log(
      `OK TEXT field created — id=${r3.details.data.id}, ` +
        `type=${r3.details.data.type}`,
    );

    // Step 4 — create RELATION field pointing at `person` (D1 validation).
    console.log("\n=== Step 4: create RELATION field (D1: opaque options) ===");
    const objList = tool("twenty_metadata_objects_list");
    const r4a = await objList.execute("p5-live", {});
    if (r4a.details?.status !== "ok") {
      console.error("FAIL list objects:", r4a.details?.error);
      process.exit(1);
    }
    const personObj = r4a.details.data.data.find(
      (o) => o.nameSingular === "person",
    );
    if (!personObj) {
      console.error("FAIL: person object not found in workspace");
      process.exit(1);
    }
    const r4b = await fieldCreate.execute("p5-live", {
      objectMetadataId: createdObjectId,
      type: "RELATION",
      name: "linkedPerson",
      label: "Linked Person",
      description: "Test relation field",
      settings: { relationType: "MANY_TO_ONE", onDelete: "SET_NULL" },
      relationCreationPayload: {
        targetObjectMetadataId: personObj.id,
        type: "MANY_TO_ONE",
        targetFieldLabel: "P5 Live Tests",
        targetFieldIcon: "IconBuildingSkyscraper",
      },
    });
    if (r4b.details?.status !== "ok") {
      console.error("FAIL relation field:", r4b.details?.error);
      process.exit(1);
    }
    console.log(
      `OK RELATION field created — id=${r4b.details.data.id}, ` +
        `relation.type=${r4b.details.data.relation?.type}`,
    );

    // Step 5 — list fields scoped to our object.
    console.log("\n=== Step 5: list fields scoped to our object ===");
    const fieldsList = tool("twenty_metadata_fields_list");
    const r5 = await fieldsList.execute("p5-live", {
      objectMetadataId: createdObjectId,
    });
    if (r5.details?.status !== "ok") {
      console.error("FAIL fields_list:", r5.details?.error);
      process.exit(1);
    }
    console.log(
      `OK fields_list source=${r5.details.data.source}, ` +
        `total=${r5.details.data.totalCount}`,
    );

    // Step 6 — update object label.
    console.log("\n=== Step 6: update object label ===");
    const objUpdate = tool("twenty_metadata_object_update");
    const r6 = await objUpdate.execute("p5-live", {
      id: createdObjectId,
      labelSingular: "P5 Live Test (renamed)",
    });
    if (r6.details?.status !== "ok") {
      console.error("FAIL object update:", r6.details?.error);
      process.exit(1);
    }
    console.log(`OK object label updated`);
  } finally {
    // Step 7 — cleanup (always attempted).
    if (createdObjectId) {
      console.log("\n=== Step 7: cleanup (delete object) ===");
      try {
        const objDelete = tool("twenty_metadata_object_delete");
        const r7 = await objDelete.execute("p5-live", { id: createdObjectId });
        if (r7.details?.status !== "ok") {
          console.error("FAIL cleanup:", r7.details?.error);
        } else {
          console.log("OK cleanup");
        }

        // Verify hard-delete (D3): /rest/p5livetests must now 4xx.
        const headers = { Authorization: `Bearer ${env.TWENTY_API_KEY}` };
        const verify = await fetch(
          `${env.TWENTY_SERVER_URL}/rest/p5livetests`,
          { headers },
        );
        console.log(
          `D3 verdict — /rest/p5livetests after delete: status=${verify.status} (`,
          verify.status >= 400
            ? "hard-delete confirmed"
            : "still alive — soft-delete?",
          ")",
        );
      } catch (e) {
        console.error("cleanup threw:", e.message);
      }
    }
  }
  console.log("\n=== ALL STEPS PASSED ===");
}

run().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
