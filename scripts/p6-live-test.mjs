// P6 live full-lifecycle test — exercises the 5 generic record tools
// against a fresh, temporary custom object.
//
// Steps:
//   1. Create a temp object 'p6testobjects' (camelCase, plural).
//   2. Add a TEXT field 'someField'.
//   3. CREATE a record via twenty_record_create.
//   4. LIST records.
//   5. GET the record by id.
//   6. UPDATE the record (someField: hello → world).
//   7. PATH TRAVERSAL — assert rejection BEFORE network call.
//   8. DELETE the record (soft-delete).
//   9. Cleanup field + object.
//
// Exits 0 on success, 1 on any step failure.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { TwentyClient } from "../dist/twenty-client.js";
import { resolveConfig } from "../dist/config.js";
import { buildMetadataTools } from "../dist/tools/metadata.js";
import { buildRecordTools } from "../dist/tools/records.js";

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
if (!existsSync(dotenvPath)) {
  console.error(`Missing .env at ${dotenvPath}`);
  process.exit(2);
}
const env = parseDotEnv(dotenvPath);
for (const k of ["TWENTY_API_KEY", "TWENTY_SERVER_URL", "TWENTY_WORKSPACE_ID"]) {
  if (!env[k]) {
    console.error(`Missing ${k}`);
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
const metaTools = Object.fromEntries(
  buildMetadataTools(client).map((t) => [t.name, t]),
);
const recTools = Object.fromEntries(
  buildRecordTools(client).map((t) => [t.name, t]),
);

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`  ${msg}`);
}

// 1. Create temp object
console.log("[1] Create object 'p6testobjects'");
const objR = await metaTools.twenty_metadata_object_create.execute("p6", {
  nameSingular: "p6testobject",
  namePlural: "p6testobjects",
  labelSingular: "P6 Test Object",
  labelPlural: "P6 Test Objects",
  icon: "IconBug",
});
if (objR.details?.status !== "ok") {
  fail(`object create: ${JSON.stringify(objR.details)}`);
}
const objId = objR.details.data.id;
ok(`object created: ${objId}`);

let fieldId = null;
let recId = null;

try {
  // 2. Add TEXT field 'someField'
  console.log("[2] Create field 'someField' (TEXT)");
  const fieldR = await metaTools.twenty_metadata_field_create.execute("p6", {
    objectMetadataId: objId,
    type: "TEXT",
    name: "someField",
    label: "Some Field",
  });
  if (fieldR.details?.status !== "ok") {
    fail(`field create: ${JSON.stringify(fieldR.details)}`);
  }
  fieldId = fieldR.details.data.id;
  ok(`field created: ${fieldId}`);

  // 3. CREATE record
  console.log("[3] twenty_record_create");
  const recR = await recTools.twenty_record_create.execute("p6", {
    entity: "p6testobjects",
    data: { someField: "hello" },
  });
  if (recR.details?.status !== "ok") {
    fail(`record create: ${JSON.stringify(recR.details)}`);
  }
  recId = recR.details.data.id;
  ok(`record created: id=${recId} someField=${recR.details.data.someField}`);

  // 4. LIST records
  console.log("[4] twenty_record_list");
  const listR = await recTools.twenty_record_list.execute("p6", {
    entity: "p6testobjects",
  });
  if (listR.details?.status !== "ok") {
    fail(`record list: ${JSON.stringify(listR.details)}`);
  }
  const listCount = listR.details.data?.data?.length ?? 0;
  ok(`listed ${listCount} record(s)`);
  if (listCount < 1) fail("expected at least 1 record");

  // 5. GET record
  console.log("[5] twenty_record_get");
  const getR = await recTools.twenty_record_get.execute("p6", {
    entity: "p6testobjects",
    id: recId,
  });
  if (getR.details?.status !== "ok") {
    fail(`record get: ${JSON.stringify(getR.details)}`);
  }
  ok(`get someField=${getR.details.data?.someField}`);
  if (getR.details.data?.someField !== "hello") {
    fail(`expected someField='hello', got '${getR.details.data?.someField}'`);
  }

  // 6. UPDATE record
  console.log("[6] twenty_record_update");
  const updR = await recTools.twenty_record_update.execute("p6", {
    entity: "p6testobjects",
    id: recId,
    data: { someField: "world" },
  });
  if (updR.details?.status !== "ok") {
    fail(`record update: ${JSON.stringify(updR.details)}`);
  }
  ok(`updated someField=${updR.details.data?.someField}`);
  if (updR.details.data?.someField !== "world") {
    fail(`expected someField='world', got '${updR.details.data?.someField}'`);
  }

  // 7. PATH TRAVERSAL — must reject pre-network
  console.log("[7] path traversal: entity='people/../../etc/passwd'");
  const badR = await recTools.twenty_record_list.execute("p6", {
    entity: "people/../../etc/passwd",
  });
  if (
    badR.details?.status === "failed" &&
    /entity/i.test(String(badR.details.error ?? ""))
  ) {
    ok(
      `rejected pre-network: ${String(badR.details.error).slice(0, 80)}`,
    );
  } else {
    fail(`path traversal NOT rejected: ${JSON.stringify(badR.details)}`);
  }

  // 8. DELETE record
  console.log("[8] twenty_record_delete (soft)");
  const delR = await recTools.twenty_record_delete.execute("p6", {
    entity: "p6testobjects",
    id: recId,
  });
  if (delR.details?.status !== "ok") {
    fail(`record delete: ${JSON.stringify(delR.details)}`);
  }
  ok(`deleted record id=${delR.details.data?.id ?? "?"}`);
  recId = null; // signal cleanup not needed
} finally {
  // 9. Cleanup — always attempt, log if it fails
  console.log("[9] cleanup");
  if (fieldId) {
    const r = await metaTools.twenty_metadata_field_delete.execute("p6", {
      id: fieldId,
    });
    ok(`field delete: ${r.details?.status}`);
  }
  const r = await metaTools.twenty_metadata_object_delete.execute("p6", {
    id: objId,
  });
  ok(`object delete: ${r.details?.status}`);
}

console.log("\nP6 live full-lifecycle: PASS");
process.exit(0);
