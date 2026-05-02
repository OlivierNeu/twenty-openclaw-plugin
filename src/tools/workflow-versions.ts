// Workflow version tools (P8) — 6 tools managing the version lifecycle:
// get current, fork to draft, activate, deactivate, archive, delete.
//
// A WorkflowVersion is what actually runs. The Workflow record is just
// a named container; each version is the immutable-once-active snapshot
// of trigger + steps. The lifecycle is:
//
//   create_complete   →  DRAFT  ─ activate ─→  ACTIVE
//   create_draft       →  DRAFT (forked from existing version)
//                                    ↓ deactivate
//                                 DEACTIVATED  ─ archive ─→ ARCHIVED
//
// `version_activate` and `version_deactivate` impact production →
// approval-gated. `version_delete` is a HARD destroy → approval-gated.

import { Type } from "@sinclair/typebox";

import { defineTwentyTool } from "./_factory.js";
import type { TwentyClient } from "../twenty-client.js";

const GetCurrentVersionSchema = Type.Object({
  workflowId: Type.String({ description: "Workflow record UUID." }),
});

const CreateDraftSchema = Type.Object({
  workflowVersionId: Type.String({
    description:
      "UUID of the source version to fork. The new version is in DRAFT " +
      "status with the same trigger + steps copied.",
  }),
});

const ActivateSchema = Type.Object({
  workflowVersionId: Type.String({
    description: "UUID of the WorkflowVersion to activate (set to ACTIVE).",
  }),
});

const DeactivateSchema = ActivateSchema;

const ArchiveSchema = Type.Object({
  workflowVersionId: Type.String({
    description: "UUID of the WorkflowVersion to archive (set status=ARCHIVED).",
  }),
});

const DeleteSchema = Type.Object({
  workflowVersionId: Type.String({
    description: "UUID of the WorkflowVersion to HARD-delete (irreversible).",
  }),
});

interface WorkflowVersionLite {
  id: string;
  name: string | null;
  status: string;
  workflowId: string;
  trigger: unknown;
  steps: unknown;
  createdAt: string;
  updatedAt: string;
}

export function buildWorkflowVersionTools(client: TwentyClient) {
  return [
    defineTwentyTool(
      {
        name: "twenty_workflow_version_get_current",
        description:
          "Get the current (most recent ACTIVE if any, else most recent DRAFT) " +
          "version of a workflow. Returns trigger + steps so the agent can " +
          "inspect the live config before editing.",
        parameters: GetCurrentVersionSchema,
        run: async (params, c, signal) => {
          // Fetch the workflow first to read lastPublishedVersionId.
          const wfResp = await c.request<{
            data?: { workflow?: { id: string; lastPublishedVersionId: string | null } };
          }>(
            "GET",
            `/rest/workflows/${encodeURIComponent(params.workflowId)}`,
            { signal },
          );
          const workflow = wfResp?.data?.workflow;
          if (!workflow) {
            throw new Error(`Workflow ${params.workflowId} not found`);
          }

          // If there's a published version, that's the current one.
          if (workflow.lastPublishedVersionId) {
            const versionResp = await c.request<{
              data?: { workflowVersion?: WorkflowVersionLite };
            }>(
              "GET",
              `/rest/workflowVersions/${encodeURIComponent(workflow.lastPublishedVersionId)}`,
              { signal },
            );
            const version = versionResp?.data?.workflowVersion;
            if (version) {
              return { source: "lastPublished", version };
            }
          }

          // Fallback: most recent DRAFT (newest first).
          const draftResp = await c.request<{
            data?: { workflowVersions?: WorkflowVersionLite[] };
          }>("GET", "/rest/workflowVersions", {
            query: {
              filter: `workflowId[eq]:"${params.workflowId}"`,
              order_by: "createdAt[DescNullsLast]",
              limit: 1,
            },
            signal,
          });
          const versions = draftResp?.data?.workflowVersions ?? [];
          if (versions.length === 0) {
            return {
              source: "none",
              version: null,
              hint:
                "Workflow has no versions yet. Use twenty_workflow_create_complete " +
                "to add one.",
            };
          }
          return { source: "mostRecent", version: versions[0] };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_workflow_version_create_draft",
        description:
          "Fork an existing WorkflowVersion into a new DRAFT — Twenty's " +
          "`createDraftFromWorkflowVersion` mutation. The new draft has the " +
          "same trigger + steps copied, in DRAFT status, ready to edit. The " +
          "original version is unchanged. Use this before editing an ACTIVE " +
          "version (Twenty rejects edits to ACTIVE versions).",
        mutates: true,
        parameters: CreateDraftSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            createDraftFromWorkflowVersion: {
              id: string;
              name: string;
              status: string;
            };
          }>(
            `mutation CreateDraft($workflowVersionIdToCopy: UUID!) {
              createDraftFromWorkflowVersion(
                input: { workflowVersionIdToCopy: $workflowVersionIdToCopy }
              ) { id name status }
            }`,
            { workflowVersionIdToCopy: params.workflowVersionId },
            { endpoint: "graphql", signal },
          );
          return data.createDraftFromWorkflowVersion;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_workflow_version_activate",
        description:
          "Activate a WorkflowVersion (sets status=ACTIVE). When the trigger " +
          "is DATABASE_EVENT or CRON, this **starts the workflow running in " +
          "production** — it will fire on every matching record event or on " +
          "the cron schedule. Approval-gated by default. Requires the API " +
          "key user to have the `WORKFLOWS` permission flag.",
        mutates: true,
        parameters: ActivateSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            activateWorkflowVersion: boolean;
          }>(
            `mutation Activate($workflowVersionId: UUID!) {
              activateWorkflowVersion(workflowVersionId: $workflowVersionId)
            }`,
            { workflowVersionId: params.workflowVersionId },
            { endpoint: "graphql", signal },
          );
          return {
            workflowVersionId: params.workflowVersionId,
            activated: data.activateWorkflowVersion === true,
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_workflow_version_deactivate",
        description:
          "Deactivate a WorkflowVersion (sets status=DEACTIVATED). The " +
          "workflow stops triggering immediately. In-flight runs are NOT " +
          "stopped — use twenty_workflow_run_stop for that. Approval-gated " +
          "by default. Requires `WORKFLOWS` permission.",
        mutates: true,
        parameters: DeactivateSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            deactivateWorkflowVersion: boolean;
          }>(
            `mutation Deactivate($workflowVersionId: UUID!) {
              deactivateWorkflowVersion(workflowVersionId: $workflowVersionId)
            }`,
            { workflowVersionId: params.workflowVersionId },
            { endpoint: "graphql", signal },
          );
          return {
            workflowVersionId: params.workflowVersionId,
            deactivated: data.deactivateWorkflowVersion === true,
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_workflow_version_archive",
        description:
          "Archive a WorkflowVersion (status=ARCHIVED). Archived versions " +
          "stay in the database for audit but cannot be activated again. Use " +
          "for cleanup of old versions you don't want to delete entirely. " +
          "Not approval-gated (reversible — can be set back to DRAFT via " +
          "twenty_workflow_version_update if needed).",
        mutates: true,
        parameters: ArchiveSchema,
        run: async (params, c, signal) => {
          const resp = await c.request<{
            data?: { updateWorkflowVersion?: { id: string; status: string } };
          }>(
            "PATCH",
            `/rest/workflowVersions/${encodeURIComponent(params.workflowVersionId)}`,
            { body: { status: "ARCHIVED" }, signal },
          );
          return resp?.data?.updateWorkflowVersion ?? null;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_workflow_version_delete",
        description:
          "HARD-delete a WorkflowVersion. Irreversible. Cascades to its " +
          "WorkflowRuns. Approval-gated by default. Use " +
          "twenty_workflow_version_archive for a reversible alternative.",
        mutates: true,
        parameters: DeleteSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            destroyWorkflowVersion: { id: string } | null;
          }>(
            `mutation Destroy($id: UUID!) {
              destroyWorkflowVersion(id: $id) { id }
            }`,
            { id: params.workflowVersionId },
            { endpoint: "graphql", signal },
          );
          return {
            workflowVersionId: params.workflowVersionId,
            destroyed: data.destroyWorkflowVersion?.id === params.workflowVersionId,
          };
        },
      },
      client,
    ),
  ];
}
