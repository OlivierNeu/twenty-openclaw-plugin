// Tool factory shared across every Twenty tool.
//
// The factory standardises:
//   - JSON serialisation of the tool result
//   - Error mapping (TwentyApiError, TwentyWorkspaceNotAllowedError,
//     TwentyReadOnlyError → tool failure)
//   - The `execute(toolCallId, params, signal)` signature expected by the
//     OpenClaw runtime
//
// Each domain file (workspace, people, companies, ...) declares its tools
// by calling {@link defineTwentyTool} and exporting an array, which the
// entry point collects and registers in bulk.

import type { Static, TSchema } from "@sinclair/typebox";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import {
  TwentyApiError,
  TwentyReadOnlyError,
  TwentyWorkspaceNotAllowedError,
  type TwentyClient,
} from "../twenty-client.js";

/**
 * Definition for a single Twenty tool. Generic over the TypeBox schema so
 * the `execute` body sees fully typed params.
 *
 * - `name` is the tool identifier exposed to the LLM. Convention:
 *   `twenty_<domain>_<verb>` (e.g. `twenty_people_create`).
 * - `description` is what the model sees. Keep it short and unambiguous;
 *   mention any required parameters the model is likely to forget.
 * - `parameters` is a TypeBox `Type.Object(...)` schema.
 * - `mutates` (default `false`) marks tools that write or delete data.
 *   When `true`, the factory rejects the call early if the client is in
 *   read-only mode.
 * - `run(params, client, signal)` does the actual API call. Returning a
 *   value (any JSON-serialisable shape) is enough — the factory wraps it
 *   as a text tool result for the model.
 */
export interface TwentyToolDefinition<TSchema_ extends TSchema> {
  name: string;
  description: string;
  parameters: TSchema_;
  label?: string;
  mutates?: boolean;
  run: (
    params: Static<TSchema_>,
    client: TwentyClient,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

/**
 * Wrap a {@link TwentyToolDefinition} into the `AgentTool` shape consumed
 * by `api.registerTool`. Captured in a closure so `client` is bound once
 * at plugin registration time.
 */
export function defineTwentyTool<TSchema_ extends TSchema>(
  def: TwentyToolDefinition<TSchema_>,
  client: TwentyClient,
): {
  name: string;
  description: string;
  label: string;
  parameters: TSchema_;
  execute: (
    toolCallId: string,
    params: Static<TSchema_>,
    signal?: AbortSignal,
  ) => Promise<
    AgentToolResult<{ status: "ok" | "failed"; data?: unknown; error?: string }>
  >;
} {
  const label = def.label ?? def.name;
  const mutates = def.mutates === true;

  return {
    name: def.name,
    description: def.description,
    label,
    parameters: def.parameters,
    async execute(_toolCallId, params, signal) {
      try {
        if (mutates && client.readOnly) {
          throw new TwentyReadOnlyError(def.name);
        }
        const data = await def.run(params, client, signal);
        const text =
          data === null || data === undefined
            ? "OK"
            : typeof data === "string"
              ? data
              : JSON.stringify(data, null, 2);
        return {
          content: [{ type: "text", text }],
          details: { status: "ok", data },
        };
      } catch (err) {
        // Distinguish whitelist violations and read-only refusals from
        // generic Twenty errors so the model can react accordingly (and
        // so tests can assert).
        if (err instanceof TwentyWorkspaceNotAllowedError) {
          return {
            content: [{ type: "text", text: `Refused: ${err.message}` }],
            details: { status: "failed", error: err.message },
          };
        }
        if (err instanceof TwentyReadOnlyError) {
          return {
            content: [{ type: "text", text: `Refused: ${err.message}` }],
            details: { status: "failed", error: err.message },
          };
        }
        if (err instanceof TwentyApiError) {
          return {
            content: [
              {
                type: "text",
                text: `Twenty API error (${err.status}): ${err.bodyPreview.slice(0, 300)}`,
              },
            ],
            details: { status: "failed", error: err.message },
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          details: { status: "failed", error: msg },
        };
      }
    },
  };
}
