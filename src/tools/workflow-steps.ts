// Workflow step + edge tools (P8) — 7 tools managing the graph of an
// individual WorkflowVersion. None are approval-gated: building a
// workflow is an iterative process (add → check → tweak → re-add) and
// approval prompts at every step would cripple the LLM.
//
// All these mutations require the `WORKFLOWS` permission flag on the
// API key user.

import { Type } from "@sinclair/typebox";

import { defineTwentyTool } from "./_factory.js";
import {
  WorkflowActionTypeSchema,
  WorkflowStepSchema,
  WorkflowTriggerSchema,
} from "./workflow-schemas.js";
import type { TwentyClient } from "../twenty-client.js";

const StepAddSchema = Type.Object({
  workflowVersionId: Type.String({
    description:
      "Parent WorkflowVersion UUID (must be in DRAFT status — Twenty " +
      "rejects edits on ACTIVE versions).",
  }),
  stepType: WorkflowActionTypeSchema,
  parentStepId: Type.Optional(
    Type.String({
      description:
        'ID of the step (or "trigger") to attach this new step under. If ' +
        "omitted, the step is added as a leaf — the agent must call " +
        "edge_add separately to wire it into the flow.",
    }),
  ),
  nextStepId: Type.Optional(
    Type.String({
      description:
        "Optional id of a step to insert BETWEEN parentStepId and " +
        "nextStepId — i.e. splice into an existing edge. If omitted, the " +
        "new step is appended after parentStepId.",
    }),
  ),
});

const StepUpdateSchema = Type.Object({
  step: WorkflowStepSchema,
  workflowVersionId: Type.String({
    description: "Parent WorkflowVersion UUID.",
  }),
});

const StepDeleteSchema = Type.Object({
  workflowVersionId: Type.String(),
  stepId: Type.String({
    description: "UUID of the step to remove (incoming/outgoing edges are dropped).",
  }),
});

const StepDuplicateSchema = Type.Object({
  workflowVersionId: Type.String(),
  stepId: Type.String({ description: "UUID of the step to duplicate." }),
});

const EdgeAddSchema = Type.Object({
  workflowVersionId: Type.String(),
  source: Type.String({
    description: 'Source step id, or the literal "trigger".',
  }),
  target: Type.String({ description: "Target step id." }),
});

const EdgeDeleteSchema = EdgeAddSchema;

const ComputeOutputSchemaInput = Type.Object({
  workflowVersionId: Type.String(),
  step: Type.Optional(
    Type.Union([WorkflowStepSchema, WorkflowTriggerSchema], {
      description:
        "Either a step or the trigger to compute the output schema for. " +
        "Useful before chaining: lets the LLM see what fields are exposed " +
        "via {{<step-id>.result.x}} downstream.",
    }),
  ),
});

const TriggerUpdateSchema = Type.Object({
  workflowVersionId: Type.String(),
  trigger: WorkflowTriggerSchema,
});

const PositionsUpdateSchema = Type.Object({
  workflowVersionId: Type.String(),
  positions: Type.Array(
    Type.Object({
      id: Type.String({
        description: 'Step id, or "trigger" for the trigger step.',
      }),
      position: Type.Object({
        x: Type.Number(),
        y: Type.Number(),
      }),
    }),
  ),
});

export function buildWorkflowStepTools(client: TwentyClient) {
  return [
    defineTwentyTool(
      {
        name: "twenty_workflow_step_add",
        description:
          "Add a new step (one of the 17 WorkflowActionType) to a DRAFT " +
          "WorkflowVersion. Twenty auto-creates the step with default " +
          "settings; call twenty_workflow_step_update to fill in the actual " +
          "configuration.\n\n" +
          "For CODE steps: this tool ALSO auto-creates the underlying " +
          "logicFunction (TS function source). Use twenty_logic_function_" +
          "update_source to set the actual JS code.\n\n" +
          "Requires `WORKFLOWS` permission.",
        mutates: true,
        parameters: StepAddSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            createWorkflowVersionStep: {
              steps: unknown[];
              edges?: unknown[];
              createdStepId?: string;
            };
          }>(
            `mutation StepAdd($input: CreateWorkflowVersionStepInput!) {
              createWorkflowVersionStep(input: $input) {
                steps
                edges
                createdStepId
              }
            }`,
            {
              input: {
                workflowVersionId: params.workflowVersionId,
                stepType: params.stepType,
                parentStepId: params.parentStepId,
                nextStepId: params.nextStepId,
              },
            },
            { endpoint: "graphql", signal },
          );
          return data.createWorkflowVersionStep;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_workflow_step_update",
        description:
          "Replace an existing step's full configuration (name, type, " +
          "settings, position, valid). The agent passes the complete step " +
          "object — Twenty does NOT do partial PATCH on steps. Use " +
          "twenty_workflow_get first to fetch the current step shape.\n\n" +
          "Requires `WORKFLOWS` permission.",
        mutates: true,
        parameters: StepUpdateSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            updateWorkflowVersionStep: { id: string; type: string };
          }>(
            `mutation StepUpdate($input: UpdateWorkflowVersionStepInput!) {
              updateWorkflowVersionStep(input: $input) { id type }
            }`,
            {
              input: {
                workflowVersionId: params.workflowVersionId,
                step: params.step,
              },
            },
            { endpoint: "graphql", signal },
          );
          return data.updateWorkflowVersionStep;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_workflow_step_delete",
        description:
          "Remove a step from a DRAFT WorkflowVersion. Incoming/outgoing " +
          "edges are dropped automatically. Returns the post-delete steps + " +
          "edges so the agent can re-validate.\n\n" +
          "Requires `WORKFLOWS` permission.",
        mutates: true,
        parameters: StepDeleteSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            deleteWorkflowVersionStep: { steps: unknown[]; edges?: unknown[] };
          }>(
            `mutation StepDelete($input: DeleteWorkflowVersionStepInput!) {
              deleteWorkflowVersionStep(input: $input) {
                steps
                edges
              }
            }`,
            {
              input: {
                workflowVersionId: params.workflowVersionId,
                stepId: params.stepId,
              },
            },
            { endpoint: "graphql", signal },
          );
          return data.deleteWorkflowVersionStep;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_workflow_step_duplicate",
        description:
          "Clone an existing step into a new step with the same settings. " +
          "Useful for forking a SEND_EMAIL step into multiple recipient " +
          "variants without re-typing the body.\n\n" +
          "Requires `WORKFLOWS` permission.",
        mutates: true,
        parameters: StepDuplicateSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            duplicateWorkflowVersionStep: {
              steps: unknown[];
              edges?: unknown[];
              createdStepId?: string;
            };
          }>(
            `mutation StepDup($input: DuplicateWorkflowVersionStepInput!) {
              duplicateWorkflowVersionStep(input: $input) {
                steps
                edges
                createdStepId
              }
            }`,
            {
              input: {
                workflowVersionId: params.workflowVersionId,
                stepId: params.stepId,
              },
            },
            { endpoint: "graphql", signal },
          );
          return data.duplicateWorkflowVersionStep;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_workflow_edge_add",
        description:
          'Connect two steps with an edge (source → target). Use ' +
          'source="trigger" to wire from the trigger.\n\n' +
          "Requires `WORKFLOWS` permission.",
        mutates: true,
        parameters: EdgeAddSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            createWorkflowVersionEdge: { steps: unknown[]; edges?: unknown[] };
          }>(
            `mutation EdgeAdd($input: CreateWorkflowVersionEdgeInput!) {
              createWorkflowVersionEdge(input: $input) {
                steps
                edges
              }
            }`,
            {
              input: {
                workflowVersionId: params.workflowVersionId,
                source: params.source,
                target: params.target,
              },
            },
            { endpoint: "graphql", signal },
          );
          return data.createWorkflowVersionEdge;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_workflow_edge_delete",
        description:
          "Remove an edge between two steps. The two steps remain in the " +
          "graph but are no longer connected.\n\n" +
          "Requires `WORKFLOWS` permission.",
        mutates: true,
        parameters: EdgeDeleteSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            deleteWorkflowVersionEdge: { steps: unknown[]; edges?: unknown[] };
          }>(
            `mutation EdgeDel($input: DeleteWorkflowVersionEdgeInput!) {
              deleteWorkflowVersionEdge(input: $input) {
                steps
                edges
              }
            }`,
            {
              input: {
                workflowVersionId: params.workflowVersionId,
                source: params.source,
                target: params.target,
              },
            },
            { endpoint: "graphql", signal },
          );
          return data.deleteWorkflowVersionEdge;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_workflow_compute_step_output_schema",
        description:
          "Compute the output schema of a step (or the trigger). Returns " +
          "the JSON shape that downstream steps can reference via " +
          "{{<step-id>.result.fieldName}}. Useful before wiring an edge or " +
          "writing a {{}} variable in a SEND_EMAIL body — the agent can " +
          "see what fields are actually exposed.\n\n" +
          "Requires `WORKFLOWS` permission.",
        parameters: ComputeOutputSchemaInput,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            computeStepOutputSchema: unknown;
          }>(
            `mutation Compute($input: ComputeStepOutputSchemaInput!) {
              computeStepOutputSchema(input: $input)
            }`,
            { input: params },
            { endpoint: "graphql", signal },
          );
          return data.computeStepOutputSchema;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_workflow_trigger_update",
        description:
          "Replace the trigger of a DRAFT WorkflowVersion. The agent passes " +
          "the complete trigger object (typed by `type`). Use " +
          "twenty_workflow_get first to fetch the current trigger shape.\n\n" +
          "Requires `WORKFLOWS` permission.",
        mutates: true,
        parameters: TriggerUpdateSchema,
        run: async (params, c, signal) => {
          // The `update_workflow_version_trigger` internal tool maps to
          // the workflow-version step builder service. We hit the standard
          // updateWorkflowVersion mutation with the trigger field; if
          // Twenty exposes a dedicated trigger mutation in a future
          // version we can switch to it without changing the tool surface.
          const resp = await c.request<{
            data?: { updateWorkflowVersion?: { id: string } };
          }>(
            "PATCH",
            `/rest/workflowVersions/${encodeURIComponent(params.workflowVersionId)}`,
            { body: { trigger: params.trigger }, signal },
          );
          return resp?.data?.updateWorkflowVersion ?? null;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_workflow_positions_update",
        description:
          'Update the visual layout positions of every step + the trigger. ' +
          'Use id="trigger" for the trigger step. Cosmetic only — does NOT ' +
          "affect execution flow.\n\n" +
          "Requires `WORKFLOWS` permission.",
        mutates: true,
        parameters: PositionsUpdateSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            updateWorkflowVersionPositions: boolean;
          }>(
            `mutation Positions($input: UpdateWorkflowVersionPositionsInput!) {
              updateWorkflowVersionPositions(input: $input)
            }`,
            { input: params },
            { endpoint: "graphql", signal },
          );
          return {
            workflowVersionId: params.workflowVersionId,
            updated: data.updateWorkflowVersionPositions === true,
          };
        },
      },
      client,
    ),
  ];
}
