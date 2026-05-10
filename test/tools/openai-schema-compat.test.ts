// Regression guard: every tool's `parameters` schema MUST be compatible
// with OpenAI's function-tool format. OpenAI rejects a function whose
// top-level schema uses `allOf` / `oneOf` / `anyOf` / `enum` / `not`.
//
// This bit us once (v0.8.0 → v0.8.1): `Type.Intersect([...])` from
// TypeBox emits `allOf` at the top level, which made
// `twenty_list_columns_set_order` and `twenty_list_columns_set_visibility`
// fail with `invalid_function_parameters` and pin the agent's event
// loop in a retry loop. The test below iterates every registered tool
// across every builder so we catch any future regression at CI time.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveConfig } from "../../src/config.js";
import { TwentyClient } from "../../src/twenty-client.js";

import { buildActivitiesTools } from "../../src/tools/activities.js";
import { buildBulkTools } from "../../src/tools/bulk.js";
import { buildCompaniesTools } from "../../src/tools/companies.js";
import { buildDedupTools } from "../../src/tools/dedup.js";
import { buildExportTools } from "../../src/tools/export.js";
import { buildFieldConfigTools } from "../../src/tools/field-config.js";
import { buildListColumnsTools } from "../../src/tools/list-columns.js";
import { buildLogicFunctionTools } from "../../src/tools/logic-functions.js";
import { buildMetadataTools } from "../../src/tools/metadata.js";
import { buildNotesTools } from "../../src/tools/notes.js";
import { buildOpportunitiesTools } from "../../src/tools/opportunities.js";
import { buildPageLayoutsTools } from "../../src/tools/page-layouts.js";
import { buildPeopleTools } from "../../src/tools/people.js";
import { buildRecordTools } from "../../src/tools/records.js";
import { buildRolesTools } from "../../src/tools/roles.js";
import { buildSummarizeTools } from "../../src/tools/summarize.js";
import { buildTasksTools } from "../../src/tools/tasks.js";
import { buildViewsTools } from "../../src/tools/views.js";
import { buildWorkflowTools } from "../../src/tools/workflows.js";
import { buildWorkflowRunTools } from "../../src/tools/workflow-runs.js";
import { buildWorkflowStepTools } from "../../src/tools/workflow-steps.js";
import { buildWorkflowVersionTools } from "../../src/tools/workflow-versions.js";
import { buildWorkspaceTools } from "../../src/tools/workspace.js";

const FORBIDDEN_TOP_LEVEL_KEYS = [
  "allOf",
  "oneOf",
  "anyOf",
  "enum",
  "not",
];

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeClient() {
  const config = resolveConfig({
    apiKey: "test-key",
    serverUrl: "https://crm.test.local",
    allowedWorkspaceIds: ["ws-1"],
    defaultWorkspaceId: "ws-1",
  });
  return new TwentyClient(config, silentLogger);
}

describe("OpenAI function-tool schema compatibility (regression guard)", () => {
  it(
    "every registered tool's `parameters` schema is `type: object` with no " +
      "forbidden top-level composition (allOf / oneOf / anyOf / enum / not)",
    () => {
      const client = makeClient();
      const allTools = [
        ...buildActivitiesTools(client),
        ...buildBulkTools(client, { allowedImportPaths: ["/tmp/"] }),
        ...buildCompaniesTools(client),
        ...buildDedupTools(client),
        ...buildExportTools(client),
        ...buildFieldConfigTools(client),
        ...buildListColumnsTools(client),
        ...buildLogicFunctionTools(client),
        ...buildMetadataTools(client),
        ...buildNotesTools(client),
        ...buildOpportunitiesTools(client),
        ...buildPageLayoutsTools(client),
        ...buildPeopleTools(client),
        ...buildRecordTools(client),
        ...buildRolesTools(client),
        ...buildSummarizeTools(client),
        ...buildTasksTools(client),
        ...buildViewsTools(client),
        ...buildWorkflowTools(client),
        ...buildWorkflowRunTools(client),
        ...buildWorkflowStepTools(client),
        ...buildWorkflowVersionTools(client),
        ...buildWorkspaceTools(client),
      ];

      const offenders: Array<{ tool: string; key: string }> = [];
      for (const tool of allTools) {
        const schema = (tool.parameters as unknown) as Record<
          string,
          unknown
        >;
        // Top-level type MUST be 'object'.
        if (schema.type !== "object") {
          offenders.push({
            tool: tool.name,
            key: `top-level type=${JSON.stringify(schema.type)}`,
          });
        }
        for (const k of FORBIDDEN_TOP_LEVEL_KEYS) {
          if (k in schema) {
            offenders.push({ tool: tool.name, key: k });
          }
        }
      }

      assert.deepEqual(
        offenders,
        [],
        `Some tools have schemas OpenAI rejects: ${JSON.stringify(offenders, null, 2)}`,
      );
      // Sanity: tool count must be > 100 (we should be at 148+).
      assert.ok(
        allTools.length >= 100,
        `Expected at least 100 tools, got ${allTools.length}`,
      );
    },
  );
});
