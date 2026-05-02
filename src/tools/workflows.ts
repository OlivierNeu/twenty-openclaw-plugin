// Workflow-level tools (P8).
//
// Twenty workflows are stored across 4 entities:
//   1. Workflow (the named container, REST /rest/workflows + GraphQL /graphql)
//   2. WorkflowVersion (the actual logic — trigger + steps[], versioned)
//   3. WorkflowRun (each execution)
//   4. WorkflowAutomatedTrigger (link table for active automated triggers)
//
// `workflow_create_complete` cascades Workflow → Version → N×Steps →
// N×Edges → opt activate, mirroring Twenty's internal
// `create_complete_workflow` LLM tool.
//
// Permission gates: action mutations (`runWorkflowVersion`,
// `activateWorkflowVersion`, etc.) are gated by Twenty's
// `SettingsPermissionGuard(WORKFLOWS)`. Standard CRUD on the entities is
// only gated by entity-level read/write permission. See README for the
// full perm matrix.

import { Type } from "@sinclair/typebox";

import { defineTwentyTool } from "./_factory.js";
import {
  WorkflowEdgeSchema,
  WorkflowStepPositionSchema,
  WorkflowStepSchema,
  WorkflowTriggerSchema,
} from "./workflow-schemas.js";
import type { TwentyClient } from "../twenty-client.js";

const ListWorkflowsSchema = Type.Object({
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 200, default: 60 }),
  ),
  starting_after: Type.Optional(Type.String()),
});

const GetWorkflowSchema = Type.Object({
  workflowId: Type.String({ description: "Workflow record UUID" }),
  recentRunsLimit: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 50,
      default: 10,
      description: "Number of most recent runs to return alongside (default 10).",
    }),
  ),
});

const DuplicateWorkflowSchema = Type.Object({
  id: Type.String({ description: "Source workflow UUID" }),
});

const DeleteWorkflowSchema = Type.Object({
  workflowId: Type.String({ description: "Workflow UUID to HARD-delete" }),
});

const CreateCompleteWorkflowSchema = Type.Object({
  name: Type.String({ description: "Workflow name (shown in Twenty UI)." }),
  description: Type.Optional(Type.String()),
  trigger: WorkflowTriggerSchema,
  steps: Type.Array(WorkflowStepSchema, {
    description: "Action steps. Each must have a unique UUID id.",
  }),
  stepPositions: Type.Optional(
    Type.Array(WorkflowStepPositionSchema, {
      description:
        "Visual layout positions. Use stepId='trigger' for the trigger step.",
    }),
  ),
  edges: Type.Optional(
    Type.Array(WorkflowEdgeSchema, {
      description:
        "Connections between steps. Use source='trigger' for edges from the trigger.",
    }),
  ),
  activate: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "If true, activate the new version after creation. " +
        "Approval-gated separately via twenty_workflow_version_activate.",
    }),
  ),
});

interface WorkflowRecord {
  id: string;
  name: string | null;
  position: number;
  statuses: string[] | null;
  lastPublishedVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WorkflowVersionRecord {
  id: string;
  name: string | null;
  status: string;
  workflowId: string;
  trigger: unknown;
  steps: unknown;
  createdAt: string;
  updatedAt: string;
}

interface WorkflowRunRecord {
  id: string;
  name: string | null;
  status: string;
  enqueuedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  workflowVersionId: string;
}

export function buildWorkflowTools(client: TwentyClient) {
  return [
    defineTwentyTool(
      {
        name: "twenty_workflows_list",
        description:
          "List workflows in the workspace, ordered by position. Returns " +
          "id, name, statuses[], lastPublishedVersionId, timestamps for each. " +
          "Use twenty_workflow_get for a workflow's full version + run history.",
        parameters: ListWorkflowsSchema,
        run: async (params, c, signal) => {
          const limit = params.limit ?? 60;
          const resp = await c.request<{
            data?: { workflows?: WorkflowRecord[] };
            totalCount?: number;
            pageInfo?: { hasNextPage: boolean; endCursor: string | null };
          }>("GET", "/rest/workflows", {
            query: {
              limit,
              starting_after: params.starting_after,
              order_by: "position",
            },
            signal,
          });
          const workflows = resp?.data?.workflows ?? [];
          return {
            count: workflows.length,
            totalCount: resp?.totalCount ?? null,
            pageInfo: resp?.pageInfo ?? null,
            workflows,
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_workflow_get",
        description:
          "Fetch a workflow with its full context: the workflow record, " +
          "every WorkflowVersion (trigger + steps as JSON blobs), and the " +
          "N most recent WorkflowRuns (for status reporting). Returns enough " +
          "to either inspect, refactor, or write a run report.",
        parameters: GetWorkflowSchema,
        run: async (params, c, signal) => {
          // 1. The workflow record (REST).
          const wfResp = await c.request<{
            data?: { workflow?: WorkflowRecord };
          }>(
            "GET",
            `/rest/workflows/${encodeURIComponent(params.workflowId)}`,
            { signal },
          );
          const workflow = wfResp?.data?.workflow;
          if (!workflow) {
            throw new Error(`Workflow ${params.workflowId} not found`);
          }

          // 2. Every WorkflowVersion of the workflow (REST filtered).
          const versionsResp = await c.request<{
            data?: { workflowVersions?: WorkflowVersionRecord[] };
          }>("GET", "/rest/workflowVersions", {
            query: {
              filter: `workflowId[eq]:"${params.workflowId}"`,
              order_by: "createdAt[DescNullsLast]",
              limit: 50,
            },
            signal,
          });
          const versions = versionsResp?.data?.workflowVersions ?? [];

          // 3. Recent WorkflowRuns (REST filtered, optional).
          const runsLimit = params.recentRunsLimit ?? 10;
          let runs: WorkflowRunRecord[] = [];
          if (runsLimit > 0) {
            const runsResp = await c.request<{
              data?: { workflowRuns?: WorkflowRunRecord[] };
            }>("GET", "/rest/workflowRuns", {
              query: {
                filter: `workflowId[eq]:"${params.workflowId}"`,
                order_by: "createdAt[DescNullsLast]",
                limit: runsLimit,
              },
              signal,
            });
            runs = runsResp?.data?.workflowRuns ?? [];
          }

          return {
            workflow,
            versionCount: versions.length,
            versions: versions.map((v) => ({
              id: v.id,
              name: v.name,
              status: v.status,
              trigger: v.trigger,
              stepCount: Array.isArray(v.steps) ? v.steps.length : 0,
              steps: v.steps,
              createdAt: v.createdAt,
              updatedAt: v.updatedAt,
            })),
            runCount: runs.length,
            runs,
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_workflow_create_complete",
        description:
          "Create a complete workflow in one cascade: Workflow record + " +
          "WorkflowVersion + N×steps + N×edges + (optional) activation. " +
          "Mirrors Twenty's internal `create_complete_workflow` LLM tool — " +
          "preserves the same ordering invariants.\n\n" +
          "STRICT REQUIREMENTS (Twenty rejects otherwise):\n" +
          "  - trigger.type ∈ {DATABASE_EVENT, MANUAL, CRON, WEBHOOK}\n" +
          "  - For DATABASE_EVENT, settings.eventName MUST match `<object>.created|updated|deleted|upserted`\n" +
          "  - Each step has UUID id, name, type, valid:true (when ready), settings\n" +
          "  - For CREATE_RECORD/UPDATE_RECORD/UPSERT_RECORD/DELETE_RECORD/FIND_RECORDS, " +
          "settings.input.objectName lowercase\n" +
          "  - For CREATE_RECORD, settings.input.objectRecord is the actual fields (NOT 'fieldsToUpdate')\n" +
          "  - For UPDATE_RECORD, settings.input.{objectName, objectRecord, objectRecordId, fieldsToUpdate}\n" +
          "  - Use stepId='trigger' for the trigger in stepPositions and edges\n" +
          "  - For CODE steps: this tool does NOT create the underlying logicFunction. " +
          "Skip CODE steps here, then call twenty_workflow_step_add for each CODE step " +
          "(it auto-creates the function), then twenty_logic_function_update_source " +
          "to set the actual code.\n\n" +
          "VARIABLE REFS available in any string field:\n" +
          "  {{trigger.object.fieldName}}    DATABASE_EVENT triggered record\n" +
          "  {{trigger.record.fieldName}}    MANUAL with single-record availability\n" +
          "  {{trigger.body.fieldName}}      WEBHOOK POST body\n" +
          "  {{<step-uuid>.result.fieldName}} previous step output (UUID, not name)\n\n" +
          "Returns workflowId, workflowVersionId, and the step ids in creation order.",
        mutates: true,
        parameters: CreateCompleteWorkflowSchema,
        run: async (params, c, signal) => {
          // Step 1 — create the Workflow record.
          const wfResp = await c.request<{
            data?: { createWorkflow?: WorkflowRecord };
          }>("POST", "/rest/workflows", {
            body: { name: params.name },
            signal,
          });
          const workflow = wfResp?.data?.createWorkflow;
          if (!workflow) {
            throw new Error("Twenty did not return a Workflow record");
          }

          // Step 2 — create the WorkflowVersion (DRAFT) with trigger + steps
          // inlined as JSON. Twenty stores them in JSON columns.
          const wvResp = await c.request<{
            data?: { createWorkflowVersion?: WorkflowVersionRecord };
          }>("POST", "/rest/workflowVersions", {
            body: {
              workflowId: workflow.id,
              name: "v1",
              status: "DRAFT",
              trigger: params.trigger,
              steps: params.steps,
            },
            signal,
          });
          const version = wvResp?.data?.createWorkflowVersion;
          if (!version) {
            throw new Error(
              `WorkflowVersion creation failed — workflow ${workflow.id} ` +
                "exists but has no version. Run twenty_workflow_get to recover.",
            );
          }

          // Step 3 — apply step positions (visual layout) via the GraphQL
          // builder mutation if provided. This requires WORKFLOWS perm.
          if (params.stepPositions && params.stepPositions.length > 0) {
            try {
              await c.postGraphQL(
                `mutation Positions($workflowVersionId: UUID!, $positions: JSON!) {
                  updateWorkflowVersionPositions(
                    input: { workflowVersionId: $workflowVersionId, positions: $positions }
                  )
                }`,
                {
                  workflowVersionId: version.id,
                  positions: params.stepPositions.map((p) => ({
                    id: p.stepId === "trigger" ? "trigger" : p.stepId,
                    position: p.position,
                  })),
                },
                { endpoint: "graphql", signal },
              );
            } catch (err) {
              // Non-fatal: the workflow is functional even without positions.
              c.logger.warn(
                `twenty_workflow_create_complete: failed to apply step positions (workflow + version OK). ` +
                  `Error: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }

          // Step 4 — create edges via GraphQL.
          if (params.edges && params.edges.length > 0) {
            for (const edge of params.edges) {
              await c.postGraphQL(
                `mutation Edge($input: CreateWorkflowVersionEdgeInput!) {
                  createWorkflowVersionEdge(input: $input) { __typename }
                }`,
                {
                  input: {
                    workflowVersionId: version.id,
                    source: edge.source === "trigger" ? "trigger" : edge.source,
                    target: edge.target,
                  },
                },
                { endpoint: "graphql", signal },
              );
            }
          }

          // Step 5 — opt activate. Approval-gated as a separate tool, but
          // can be inlined here for atomic creation.
          let activated = false;
          if (params.activate) {
            await c.postGraphQL<{ activateWorkflowVersion: boolean }>(
              `mutation Activate($id: UUID!) {
                activateWorkflowVersion(workflowVersionId: $id)
              }`,
              { id: version.id },
              { endpoint: "graphql", signal },
            );
            activated = true;
          }

          return {
            workflowId: workflow.id,
            workflowVersionId: version.id,
            name: params.name,
            stepCount: params.steps.length,
            stepIds: params.steps.map((s) => s.id),
            triggerType: params.trigger.type,
            activated,
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_workflow_duplicate",
        description:
          "Duplicate an existing workflow (clones the workflow record + " +
          "every version + every step + every edge). The clone is in DRAFT " +
          "status — must be activated separately. Useful for spinning up a " +
          "new campaign workflow from a template.",
        mutates: true,
        parameters: DuplicateWorkflowSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            duplicateWorkflow: { id: string; name: string };
          }>(
            `mutation Duplicate($id: UUID!) {
              duplicateWorkflow(workflowId: $id) { id name }
            }`,
            { id: params.id },
            { endpoint: "graphql", signal },
          );
          return data.duplicateWorkflow;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_workflow_delete",
        description:
          "HARD-delete a workflow and all its versions + runs (cascade). " +
          "Irreversible. Approval-gated by default.",
        mutates: true,
        parameters: DeleteWorkflowSchema,
        run: async (params, c, signal) => {
          // destroyWorkflow on /graphql is the hard-delete (deleteWorkflow
          // is soft). We use destroy for full cleanup.
          const data = await c.postGraphQL<{
            destroyWorkflow: { id: string } | null;
          }>(
            `mutation DestroyWorkflow($id: UUID!) {
              destroyWorkflow(id: $id) { id }
            }`,
            { id: params.workflowId },
            { endpoint: "graphql", signal },
          );
          return {
            workflowId: params.workflowId,
            destroyed: data.destroyWorkflow?.id === params.workflowId,
          };
        },
      },
      client,
    ),
  ];
}
