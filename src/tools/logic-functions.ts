// Logic function tools (P8) — manage the TypeScript source code that
// backs CODE workflow steps.
//
// A `logicFunction` lives in the metadata API and is referenced by
// workflow CODE steps via settings.input.logicFunctionId. Twenty
// auto-creates the function record when a CODE step is added (via
// twenty_workflow_step_add). These tools let the agent read the source,
// update it, and test-execute in a sandbox.
//
// Endpoint: /metadata (logic functions are workspace metadata, not
// workspace data).

import { Type } from "@sinclair/typebox";

import { defineTwentyTool } from "./_factory.js";
import type { TwentyClient } from "../twenty-client.js";

const ListSchema = Type.Object({});

const UpdateSourceSchema = Type.Object({
  id: Type.String({ description: "logicFunction UUID." }),
  source: Type.String({
    description:
      "Full TypeScript source. Twenty exposes a default signature " +
      "`async function main(input) { ... return output; }`. The function " +
      "runs in a sandboxed runtime — no fs / network / process access " +
      "except via Twenty-provided helpers.",
  }),
});

const ExecuteSchema = Type.Object({
  id: Type.String({ description: "logicFunction UUID to execute." }),
  input: Type.Object(
    {},
    {
      additionalProperties: true,
      description:
        "Key/value map of arguments passed to the function under `input`. " +
        "Use this to test the function without running the whole workflow.",
    },
  ),
});

interface LogicFunctionRecord {
  id: string;
  name?: string | null;
  source?: string | null;
  description?: string | null;
  workflowVersionId?: string | null;
  workflowVersionStepId?: string | null;
}

export function buildLogicFunctionTools(client: TwentyClient) {
  return [
    defineTwentyTool(
      {
        name: "twenty_logic_function_list",
        description:
          "List every logicFunction in the workspace. Each function backs " +
          "the source of one CODE step in some WorkflowVersion. Returns " +
          "id, name, source, and the linked workflow/step ids when " +
          "available.",
        parameters: ListSchema,
        run: async (_params, c, signal) => {
          const data = await c.postGraphQL<{
            findManyLogicFunctions: LogicFunctionRecord[];
          }>(
            `query LogicFunctions {
              findManyLogicFunctions {
                id name source description
                workflowVersionId workflowVersionStepId
              }
            }`,
            {},
            { endpoint: "metadata", signal },
          );
          const fns = data.findManyLogicFunctions ?? [];
          return {
            count: fns.length,
            functions: fns,
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_logic_function_update_source",
        description:
          "Replace the TypeScript source of a logicFunction. Use after " +
          "twenty_workflow_step_add(stepType: CODE) — Twenty auto-creates " +
          "the function record but the source is empty until you set it " +
          "here.\n\n" +
          "The function signature is `async function main(input) { … }`. " +
          "Return any JSON-serialisable value — it becomes the step's " +
          "result accessible via `{{<step-id>.result.fieldName}}`.",
        mutates: true,
        parameters: UpdateSourceSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            updateOneLogicFunction: LogicFunctionRecord;
          }>(
            `mutation UpdateSource($input: UpdateLogicFunctionFromSourceInput!) {
              updateOneLogicFunction(input: $input) {
                id name source description
              }
            }`,
            {
              input: {
                id: params.id,
                source: params.source,
              },
            },
            { endpoint: "metadata", signal },
          );
          return data.updateOneLogicFunction;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_logic_function_execute",
        description:
          "Test-run a logicFunction in the sandbox. Returns the function's " +
          "return value plus any logs/errors. Useful to debug a CODE step " +
          "without triggering the whole workflow. Side effects are limited " +
          "by the sandbox; emails / HTTP / record writes are NOT performed " +
          "in this sandbox unless the function explicitly uses Twenty-" +
          "provided helpers.",
        mutates: true,
        parameters: ExecuteSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            executeOneLogicFunction: {
              result?: unknown;
              error?: string | null;
              logs?: unknown[];
            };
          }>(
            `mutation Execute($input: ExecuteOneLogicFunctionInput!) {
              executeOneLogicFunction(input: $input) {
                result
                error
                logs
              }
            }`,
            {
              input: {
                id: params.id,
                input: params.input,
              },
            },
            { endpoint: "metadata", signal },
          );
          return data.executeOneLogicFunction;
        },
      },
      client,
    ),
  ];
}
