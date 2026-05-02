// Twenty Activities timeline (`twenty_activities_list_for`).
//
// Twenty does NOT expose a unified `/activities` endpoint. Activities are
// modelled as join tables (`/noteTargets`, `/taskTargets`) keyed on the
// target record. This tool composes both queries in parallel and returns
// the embedded `note`/`task` objects so the agent gets a single timeline
// view of a record.
//
// Endpoint shape (verified against OpenAPI):
//   GET /noteTargets?filter=targetPersonId[eq]:<id>&depth=1
//     → { data: { noteTargets: [{ id, noteId, note: {...}, ... }] }, pageInfo, totalCount }
//   GET /taskTargets?filter=targetTaskId[eq]:<id>&depth=1
//     → { data: { taskTargets: [{ id, taskId, task: {...}, ... }] }, pageInfo, totalCount }
//
// `depth=1` is critical: without it, the embedded `note`/`task` is missing
// and the agent only gets join rows.
//
// Output shape is bespoke (NOT the unified ListOutput envelope) because
// the result joins two different collections. Pagination is intentionally
// not exposed here — for power users who need to page through hundreds
// of activities on a single record, fall back to `twenty_notes_list` /
// `twenty_tasks_list` with explicit filters.

import { Type } from "@sinclair/typebox";

import { defineTwentyTool } from "./_factory.js";
import type { TwentyClient } from "../twenty-client.js";

const TARGET_FIELD: Record<"Person" | "Company" | "Opportunity", string> = {
  Person: "targetPersonId",
  Company: "targetCompanyId",
  Opportunity: "targetOpportunityId",
};

const ACTIVITIES_DEFAULT_LIMIT = 60;
const ACTIVITIES_MAX_LIMIT = 200;

interface RawNoteTarget {
  id?: string;
  noteId?: string;
  note?: unknown;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

interface RawTaskTarget {
  id?: string;
  taskId?: string;
  task?: unknown;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

interface RawTargetsResponse<TKey extends string, TItem> {
  data?: { [K in TKey]?: TItem[] };
  pageInfo?: unknown;
  totalCount?: number;
}

export function buildActivitiesTools(client: TwentyClient) {
  return [
    defineTwentyTool(
      {
        name: "twenty_activities_list_for",
        description:
          "List the activity timeline (notes + tasks) attached to a single " +
          "Twenty record. `target_type` is one of Person, Company, " +
          "Opportunity; `target_id` is the record UUID. Returns the embedded " +
          "note/task objects directly (depth=1) so the agent does not need " +
          "follow-up calls. Capped at 200 entries per type — for fuller " +
          "exploration fall back to twenty_notes_list / twenty_tasks_list " +
          "with explicit filters.",
        parameters: Type.Object({
          target_type: Type.Union(
            [
              Type.Literal("Person"),
              Type.Literal("Company"),
              Type.Literal("Opportunity"),
            ],
            {
              description:
                "Type of the record whose timeline to fetch.",
            },
          ),
          target_id: Type.String({
            description: "UUID of the target record.",
          }),
          limit: Type.Optional(
            Type.Number({
              minimum: 0,
              maximum: ACTIVITIES_MAX_LIMIT,
              default: ACTIVITIES_DEFAULT_LIMIT,
              description:
                "Max records per category (notes, tasks). Default 60, max 200.",
            }),
          ),
        }),
        run: async (params, c, signal) => {
          const targetField = TARGET_FIELD[params.target_type];
          // Filter DSL: targetPersonId[eq]:<uuid> — the value is NOT
          // URL-encoded inside the filter string, only the whole `filter`
          // query param is encoded by `URLSearchParams` downstream.
          const filterDsl = `${targetField}[eq]:${params.target_id}`;
          const limit = params.limit ?? ACTIVITIES_DEFAULT_LIMIT;

          const sharedQuery = {
            filter: filterDsl,
            depth: 1,
            limit,
          };

          // Run both queries in parallel — they are independent and the
          // agent expects a single combined response.
          const [noteResp, taskResp] = await Promise.all([
            c.request<
              RawTargetsResponse<"noteTargets", RawNoteTarget>
            >("GET", "/noteTargets", { query: sharedQuery, signal }),
            c.request<
              RawTargetsResponse<"taskTargets", RawTaskTarget>
            >("GET", "/taskTargets", { query: sharedQuery, signal }),
          ]);

          const noteTargets = noteResp?.data?.noteTargets ?? [];
          const taskTargets = taskResp?.data?.taskTargets ?? [];

          // Surface the embedded note/task plus the relevant join metadata
          // (createdAt of the target so the agent can sort the timeline
          // even when the embedded note/task was not hydrated).
          const notes = noteTargets.map((t) => ({
            id: t.id ?? null,
            noteId: t.noteId ?? null,
            createdAt: t.createdAt ?? null,
            note: t.note ?? null,
          }));
          const tasks = taskTargets.map((t) => ({
            id: t.id ?? null,
            taskId: t.taskId ?? null,
            createdAt: t.createdAt ?? null,
            task: t.task ?? null,
          }));

          return {
            target: {
              type: params.target_type,
              id: params.target_id,
            },
            notes,
            tasks,
            counts: {
              notes: notes.length,
              tasks: tasks.length,
            },
            totalCount: {
              notes:
                typeof noteResp?.totalCount === "number"
                  ? noteResp.totalCount
                  : null,
              tasks:
                typeof taskResp?.totalCount === "number"
                  ? taskResp.totalCount
                  : null,
            },
          };
        },
      },
      client,
    ),
  ];
}
