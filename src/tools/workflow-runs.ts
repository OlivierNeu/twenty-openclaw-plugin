// Workflow run tools (P8) — execute a WorkflowVersion, stop a run,
// list runs, get full run state for reporting.
//
// `workflow_run` is approval-gated: a single call can fan out to N
// SEND_EMAIL / HTTP_REQUEST / CREATE_RECORD actions with side effects
// outside Twenty.

import { Type } from "@sinclair/typebox";

import { defineTwentyTool } from "./_factory.js";
import { WorkflowRunStatusSchema } from "./workflow-schemas.js";
import type { TwentyClient } from "../twenty-client.js";

const RunWorkflowSchema = Type.Object({
  workflowVersionId: Type.String({
    description:
      "UUID of the WorkflowVersion to execute. Must be ACTIVE for " +
      "DATABASE_EVENT/CRON triggers (those don't accept manual runs); MANUAL " +
      "and WEBHOOK versions accept manual runs in any status.",
  }),
  payload: Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: true,
        description:
          "Optional payload merged into {{trigger}} at runtime. For MANUAL " +
          "triggers with SINGLE_RECORD/BULK_RECORDS availability, pass the " +
          "selected record(s) here.",
      },
    ),
  ),
  workflowRunId: Type.Optional(
    Type.String({
      description:
        "If provided, re-uses an existing WorkflowRun record (typically " +
        "for retrying a failed run). Otherwise Twenty creates a new run.",
    }),
  ),
});

const StopRunSchema = Type.Object({
  workflowRunId: Type.String({
    description: "UUID of the WorkflowRun to stop. Sets status=STOPPING.",
  }),
});

const ListRunsSchema = Type.Object({
  workflowId: Type.Optional(
    Type.String({
      description: "Filter to runs of a specific Workflow.",
    }),
  ),
  workflowVersionId: Type.Optional(
    Type.String({
      description: "Filter to runs of a specific WorkflowVersion.",
    }),
  ),
  status: Type.Optional(
    Type.Union(
      [
        WorkflowRunStatusSchema,
        Type.Array(WorkflowRunStatusSchema, {
          description:
            'Pass an array to match multiple statuses (e.g. ["FAILED", "STOPPED"] for incident reports).',
        }),
      ],
      {
        description:
          "Filter by run status. Use a single value or an array.",
      },
    ),
  ),
  startedAfter: Type.Optional(
    Type.String({
      description: 'ISO timestamp — only runs that started after this date (e.g. "2026-01-01T00:00:00Z").',
    }),
  ),
  startedBefore: Type.Optional(Type.String()),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 200, default: 60 }),
  ),
  starting_after: Type.Optional(Type.String()),
});

const GetRunSchema = Type.Object({
  workflowRunId: Type.String({ description: "WorkflowRun UUID." }),
});

interface WorkflowRunRecord {
  id: string;
  name: string | null;
  status: string;
  enqueuedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  workflowId: string;
  workflowVersionId: string;
  state?: {
    flow?: { trigger?: { type?: string }; steps?: Array<{ type?: string; name?: string }> };
    stepInfos?: Record<string, { status?: string; error?: string }>;
    workflowRunError?: string;
  };
  createdAt: string;
}

interface WorkflowVersionLite {
  id: string;
  name: string | null;
  status: string;
  trigger: { type?: string } | null;
  steps: Array<{ type?: string; name?: string }> | null;
}

export function buildWorkflowRunTools(client: TwentyClient) {
  return [
    defineTwentyTool(
      {
        name: "twenty_workflow_run",
        description:
          "**Execute a WorkflowVersion**. This RUNS THE WORKFLOW — every " +
          "step that has side effects (SEND_EMAIL, HTTP_REQUEST, " +
          "CREATE_RECORD, DELETE_RECORD, …) is executed for real.\n\n" +
          "Approval-gated by default. The approval prompt SHOULD include a " +
          "preview of the trigger type + the list of step types so the " +
          "operator knows what's about to happen (e.g. `MANUAL → 1× " +
          "FIND_RECORDS, 1× ITERATOR, 1× SEND_EMAIL`).\n\n" +
          "Returns the workflowRunId so the agent can poll status via " +
          "twenty_workflow_run_get.\n\n" +
          "Requires `WORKFLOWS` permission.",
        mutates: true,
        parameters: RunWorkflowSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            runWorkflowVersion: {
              workflowRunId: string;
            };
          }>(
            `mutation Run($input: RunWorkflowVersionInput!) {
              runWorkflowVersion(input: $input) { workflowRunId }
            }`,
            {
              input: {
                workflowVersionId: params.workflowVersionId,
                workflowRunId: params.workflowRunId,
                payload: params.payload ?? {},
              },
            },
            { endpoint: "graphql", signal },
          );
          return data.runWorkflowVersion;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_workflow_run_stop",
        description:
          "Stop an in-flight WorkflowRun (sets status=STOPPING, then STOPPED " +
          "once the current step completes). Already-completed steps are " +
          "NOT undone. Use only if the run is hung or doing damage.\n\n" +
          "Requires `WORKFLOWS` permission.",
        mutates: true,
        parameters: StopRunSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            stopWorkflowRun: WorkflowRunRecord;
          }>(
            `mutation Stop($workflowRunId: UUID!) {
              stopWorkflowRun(workflowRunId: $workflowRunId) {
                id status
              }
            }`,
            { workflowRunId: params.workflowRunId },
            { endpoint: "graphql", signal },
          );
          return data.stopWorkflowRun;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_workflow_runs_list",
        description:
          "List WorkflowRuns with optional filters: by workflow, by " +
          "version, by status (single or array — e.g. ['FAILED','STOPPED'] " +
          "for incidents), by date range. Returns enqueuedAt / startedAt / " +
          "endedAt for each so the agent can spot SLA breaches.",
        parameters: ListRunsSchema,
        run: async (params, c, signal) => {
          const filters: string[] = [];
          if (params.workflowId)
            filters.push(`workflowId[eq]:"${params.workflowId}"`);
          if (params.workflowVersionId)
            filters.push(
              `workflowVersionId[eq]:"${params.workflowVersionId}"`,
            );
          if (params.status) {
            if (Array.isArray(params.status)) {
              const values = params.status.map((s) => `"${s}"`).join(",");
              filters.push(`status[in]:[${values}]`);
            } else {
              filters.push(`status[eq]:"${params.status}"`);
            }
          }
          if (params.startedAfter)
            filters.push(`startedAt[gte]:"${params.startedAfter}"`);
          if (params.startedBefore)
            filters.push(`startedAt[lte]:"${params.startedBefore}"`);

          const filter = filters.length > 0 ? filters.join(",") : undefined;
          const limit = params.limit ?? 60;

          const resp = await c.request<{
            data?: { workflowRuns?: WorkflowRunRecord[] };
            totalCount?: number;
            pageInfo?: { hasNextPage: boolean; endCursor: string | null };
          }>("GET", "/rest/workflowRuns", {
            query: {
              limit,
              starting_after: params.starting_after,
              filter,
              order_by: "createdAt[DescNullsLast]",
            },
            signal,
          });

          const runs = resp?.data?.workflowRuns ?? [];
          return {
            count: runs.length,
            totalCount: resp?.totalCount ?? null,
            pageInfo: resp?.pageInfo ?? null,
            runs: runs.map((r) => ({
              id: r.id,
              name: r.name,
              status: r.status,
              enqueuedAt: r.enqueuedAt,
              startedAt: r.startedAt,
              endedAt: r.endedAt,
              durationMs:
                r.startedAt && r.endedAt
                  ? new Date(r.endedAt).getTime() -
                    new Date(r.startedAt).getTime()
                  : null,
              workflowId: r.workflowId,
              workflowVersionId: r.workflowVersionId,
            })),
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_workflow_run_get",
        description:
          "Fetch the full details of a single WorkflowRun, formatted for " +
          "**reporting**: status, timestamps, the original flow snapshot, " +
          "per-step infos (status + error if any), and the workflow + " +
          "version names. Use this to write a post-execution report or " +
          "debug a failed run.",
        parameters: GetRunSchema,
        run: async (params, c, signal) => {
          const resp = await c.request<{
            data?: { workflowRun?: WorkflowRunRecord };
          }>(
            "GET",
            `/rest/workflowRuns/${encodeURIComponent(params.workflowRunId)}`,
            { signal },
          );
          const run = resp?.data?.workflowRun;
          if (!run) {
            throw new Error(`WorkflowRun ${params.workflowRunId} not found`);
          }

          // Resolve the parent version (for naming) — best effort.
          let version: WorkflowVersionLite | null = null;
          try {
            const verResp = await c.request<{
              data?: { workflowVersion?: WorkflowVersionLite };
            }>(
              "GET",
              `/rest/workflowVersions/${encodeURIComponent(run.workflowVersionId)}`,
              { signal },
            );
            version = verResp?.data?.workflowVersion ?? null;
          } catch {
            // Version may have been deleted; we still return the run.
          }

          // Pretty-print the per-step status map.
          const stepInfos = run.state?.stepInfos ?? {};
          const stepReport = Object.entries(stepInfos).map(
            ([stepId, info]) => ({
              stepId,
              status: info.status ?? "UNKNOWN",
              error: info.error ?? null,
            }),
          );

          // Aggregate counts by status.
          const stepStatusCounts = stepReport.reduce<Record<string, number>>(
            (acc, s) => {
              acc[s.status] = (acc[s.status] ?? 0) + 1;
              return acc;
            },
            {},
          );

          return {
            run: {
              id: run.id,
              name: run.name,
              status: run.status,
              enqueuedAt: run.enqueuedAt,
              startedAt: run.startedAt,
              endedAt: run.endedAt,
              durationMs:
                run.startedAt && run.endedAt
                  ? new Date(run.endedAt).getTime() -
                    new Date(run.startedAt).getTime()
                  : null,
              workflowId: run.workflowId,
              workflowVersionId: run.workflowVersionId,
              workflowRunError: run.state?.workflowRunError ?? null,
            },
            version: version
              ? {
                  id: version.id,
                  name: version.name,
                  status: version.status,
                  triggerType: version.trigger?.type ?? null,
                  stepCount: Array.isArray(version.steps)
                    ? version.steps.length
                    : 0,
                }
              : null,
            stepStatusCounts,
            steps: stepReport,
            flowSnapshot: run.state?.flow ?? null,
          };
        },
      },
      client,
    ),
  ];
}
