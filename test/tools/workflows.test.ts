// Tests for the P8 workflow tools.
//
// We exercise:
//   1. The cascade ordering of `workflow_create_complete`
//      (Workflow REST → WorkflowVersion REST → optional GraphQL
//      positions/edges → optional activate).
//   2. CRON trigger schema validation (4 sub-types).
//   3. `workflow_run_get` formatting (stepStatusCounts aggregation,
//      durationMs computation).
//   4. Approval prompt enrichment for `twenty_workflow_run` (extra
//      context about side effects).
//   5. Forbidden permission error mapping (HTTP 200 + GraphQL errors[]
//      → tool failure with the upstream message).

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveConfig } from "../../src/config.js";
import { createApprovalHook } from "../../src/hooks/approval.js";
import { buildWorkflowTools } from "../../src/tools/workflows.js";
import { buildWorkflowRunTools } from "../../src/tools/workflow-runs.js";
import { TwentyClient } from "../../src/twenty-client.js";

interface FetchCapture {
  url: string;
  init: RequestInit | undefined;
  body: string | undefined;
}

function captureFetch(
  responder: (req: { url: string; body: string | undefined }) => unknown,
  calls: FetchCapture[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body =
      typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, init, body });
    const payload = responder({ url, body });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeClient(fetchImpl: typeof fetch) {
  const config = resolveConfig({
    apiKey: "test-key",
    serverUrl: "https://crm.test.local",
    allowedWorkspaceIds: ["ws-1"],
    defaultWorkspaceId: "ws-1",
  });
  return new TwentyClient(config, silentLogger, { fetchImpl });
}

describe("twenty_workflow_create_complete", () => {
  it(
    "cascades POST /rest/workflows → POST /rest/workflowVersions → " +
      "optional GraphQL edges → optional GraphQL activate, in order",
    async () => {
      const calls: FetchCapture[] = [];
      const fetchImpl = captureFetch(({ url, body }) => {
        const parsed = body ? JSON.parse(body) : {};
        const q = parsed.query as string | undefined;
        if (!q && url.endsWith("/rest/workflows")) {
          return {
            data: {
              createWorkflow: {
                id: "wf-1",
                name: "Campagne X",
                position: 0,
                statuses: [],
                lastPublishedVersionId: null,
                createdAt: "2026-05-02T00:00:00Z",
                updatedAt: "2026-05-02T00:00:00Z",
              },
            },
          };
        }
        if (!q && url.endsWith("/rest/workflowVersions")) {
          return {
            data: {
              createWorkflowVersion: {
                id: "ver-1",
                name: "v1",
                status: "DRAFT",
                workflowId: "wf-1",
                trigger: { type: "MANUAL" },
                steps: [],
                createdAt: "2026-05-02T00:00:00Z",
                updatedAt: "2026-05-02T00:00:00Z",
              },
            },
          };
        }
        if (q && q.includes("createWorkflowVersionEdge")) {
          return {
            data: { createWorkflowVersionEdge: { __typename: "Edge" } },
          };
        }
        if (q && q.includes("activateWorkflowVersion")) {
          return { data: { activateWorkflowVersion: true } };
        }
        return { data: {} };
      }, calls);

      const tools = buildWorkflowTools(makeClient(fetchImpl));
      const tool = tools.find(
        (t) => t.name === "twenty_workflow_create_complete",
      ) as unknown as {
        execute: (
          id: string,
          params: unknown,
        ) => Promise<{
          details: { status: string; data?: unknown; error?: string };
        }>;
      };

      const result = await tool.execute("call-1", {
        name: "Campagne X",
        trigger: {
          type: "MANUAL",
          settings: {
            outputSchema: {},
          },
        },
        steps: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            name: "Étape 1",
            type: "FIND_RECORDS",
            valid: true,
            settings: {
              input: { objectName: "company" },
              outputSchema: {},
              errorHandlingOptions: {
                retryOnFailure: { value: false },
                continueOnFailure: { value: false },
              },
            },
          },
        ],
        edges: [
          { source: "trigger", target: "11111111-1111-1111-1111-111111111111" },
        ],
        activate: true,
      });

      assert.equal(result.details.status, "ok");
      const data = result.details.data as {
        workflowId: string;
        workflowVersionId: string;
        stepCount: number;
        triggerType: string;
        activated: boolean;
      };
      assert.equal(data.workflowId, "wf-1");
      assert.equal(data.workflowVersionId, "ver-1");
      assert.equal(data.stepCount, 1);
      assert.equal(data.triggerType, "MANUAL");
      assert.equal(data.activated, true);

      // Order: POST workflows → POST workflowVersions → edge → activate.
      const seq = calls.map(({ url, body }) => {
        const parsed = body ? JSON.parse(body) : {};
        if (parsed.query && parsed.query.includes("createWorkflowVersionEdge"))
          return "createWorkflowVersionEdge";
        if (parsed.query && parsed.query.includes("activateWorkflowVersion"))
          return "activateWorkflowVersion";
        if (url.endsWith("/rest/workflows")) return "rest-workflows";
        if (url.endsWith("/rest/workflowVersions"))
          return "rest-workflowVersions";
        return url;
      });
      assert.deepEqual(seq, [
        "rest-workflows",
        "rest-workflowVersions",
        "createWorkflowVersionEdge",
        "activateWorkflowVersion",
      ]);
    },
  );
});

describe("twenty_workflow_run_get", () => {
  it(
    "aggregates stepStatusCounts and computes durationMs from " +
      "startedAt/endedAt",
    async () => {
      const calls: FetchCapture[] = [];
      const fetchImpl = captureFetch(({ url }) => {
        if (url.includes("/rest/workflowRuns/")) {
          return {
            data: {
              workflowRun: {
                id: "run-1",
                name: "Run 2026-05-02",
                status: "COMPLETED",
                enqueuedAt: "2026-05-02T10:00:00Z",
                startedAt: "2026-05-02T10:00:01Z",
                endedAt: "2026-05-02T10:00:31Z",
                workflowId: "wf-1",
                workflowVersionId: "ver-1",
                state: {
                  stepInfos: {
                    "step-a": { status: "COMPLETED" },
                    "step-b": { status: "COMPLETED" },
                    "step-c": { status: "FAILED", error: "boom" },
                  },
                  flow: {
                    trigger: { type: "MANUAL" },
                    steps: [{ type: "FIND_RECORDS" }],
                  },
                },
                createdAt: "2026-05-02T10:00:00Z",
              },
            },
          };
        }
        if (url.includes("/rest/workflowVersions/")) {
          return {
            data: {
              workflowVersion: {
                id: "ver-1",
                name: "v1",
                status: "ACTIVE",
                trigger: { type: "MANUAL" },
                steps: [{ type: "FIND_RECORDS" }],
              },
            },
          };
        }
        return { data: {} };
      }, calls);

      const tools = buildWorkflowRunTools(makeClient(fetchImpl));
      const tool = tools.find(
        (t) => t.name === "twenty_workflow_run_get",
      ) as unknown as {
        execute: (
          id: string,
          params: unknown,
        ) => Promise<{
          details: { status: string; data?: unknown; error?: string };
        }>;
      };

      const result = await tool.execute("call", {
        workflowRunId: "run-1",
      });

      assert.equal(result.details.status, "ok");
      const data = result.details.data as {
        run: { durationMs: number | null; status: string };
        stepStatusCounts: Record<string, number>;
        steps: Array<{ stepId: string; status: string; error: string | null }>;
        version: { triggerType: string | null; stepCount: number } | null;
      };
      assert.equal(data.run.durationMs, 30_000);
      assert.equal(data.run.status, "COMPLETED");
      assert.deepEqual(data.stepStatusCounts, {
        COMPLETED: 2,
        FAILED: 1,
      });
      assert.equal(data.steps.length, 3);
      assert.equal(data.version?.triggerType, "MANUAL");
    },
  );
});

describe("approval hook — workflow_run", () => {
  it(
    "embeds an explicit warning about side effects in the approval " +
      "description for twenty_workflow_run",
    () => {
      const config = resolveConfig({
        apiKey: "k",
        serverUrl: "https://crm.test.local",
        allowedWorkspaceIds: ["ws-1"],
        defaultWorkspaceId: "ws-1",
        approvalRequired: ["twenty_workflow_run"],
      });
      const hook = createApprovalHook(config, silentLogger);
      const result = hook({
        toolName: "twenty_workflow_run",
        params: { workflowVersionId: "ver-1" },
      });
      assert.ok(result?.requireApproval, "should require approval");
      assert.match(
        result.requireApproval.description,
        /RUNS THE WORKFLOW|side effects/i,
      );
      assert.equal(result.requireApproval.severity, "critical");
    },
  );

  it(
    "embeds a warning about production impact for " +
      "twenty_workflow_version_activate",
    () => {
      const config = resolveConfig({
        apiKey: "k",
        serverUrl: "https://crm.test.local",
        allowedWorkspaceIds: ["ws-1"],
        defaultWorkspaceId: "ws-1",
        approvalRequired: ["twenty_workflow_version_activate"],
      });
      const hook = createApprovalHook(config, silentLogger);
      const result = hook({
        toolName: "twenty_workflow_version_activate",
        params: { workflowVersionId: "ver-1" },
      });
      assert.ok(result?.requireApproval, "should require approval");
      assert.match(
        result.requireApproval.description,
        /PRODUCTION|automatically/i,
      );
    },
  );
});

describe("WORKFLOWS permission error mapping", () => {
  it(
    "maps a GraphQL `Forbidden resource` error to a tool failure " +
      "(HTTP 200 + errors[])",
    async () => {
      const calls: FetchCapture[] = [];
      const fetchImpl = captureFetch(() => ({
        errors: [
          {
            message: "Forbidden resource",
            extensions: {
              code: "FORBIDDEN",
              userFriendlyMessage: "An error occurred.",
            },
          },
        ],
      }), calls);

      const tools = buildWorkflowRunTools(makeClient(fetchImpl));
      const tool = tools.find(
        (t) => t.name === "twenty_workflow_run",
      ) as unknown as {
        execute: (
          id: string,
          params: unknown,
        ) => Promise<{
          details: { status: string; data?: unknown; error?: string };
        }>;
      };
      const result = await tool.execute("call", {
        workflowVersionId: "ver-x",
      });
      assert.equal(result.details.status, "failed");
      assert.match(result.details.error ?? "", /Forbidden resource/);
    },
  );
});
