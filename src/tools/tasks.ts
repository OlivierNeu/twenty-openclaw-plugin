// Twenty Tasks (`/rest/tasks`) read + write tools.
//
// Verified against the Twenty REST OpenAPI:
//   - GET    /tasks                 → { data: { tasks: [...] }, pageInfo, totalCount }
//   - POST   /tasks                 → 201 { data: { createTask: {...} } }
//   - PATCH  /tasks/{id}            → 200 { data: { updateTask: {...} } }
//   - DELETE /tasks/{id}            → 200 { data: { deleteTask: { id } } }
//
// Restore was prototyped in P4a but dropped — see comments in people.ts.
//
// `twenty_activities_list_for` is the preferred way to list tasks attached
// to a specific person/company/opportunity (it joins via taskTargets).

import { Type } from "@sinclair/typebox";

import {
  buildCreateTool,
  buildDeleteTool,
  buildListTool,
  buildUpdateTool,
} from "./_factory.js";
import type { TwentyClient } from "../twenty-client.js";
import type { TwentyTask } from "../types.js";

// Tasks share Notes' `bodyV2` rich-text shape — markdown is the path of
// least resistance for the agent.
const TaskBodySchema = Type.Object({
  markdown: Type.Optional(
    Type.String({
      description:
        "Task body as markdown. Twenty converts to its rich-text format internally.",
    }),
  ),
  blocknote: Type.Optional(
    Type.String({
      description: "Task body as BlockNote JSON (advanced — prefer markdown).",
    }),
  ),
});

const TaskCreateSchema = Type.Object({
  title: Type.Optional(Type.String({ description: "Task title" })),
  bodyV2: Type.Optional(TaskBodySchema),
  dueAt: Type.Optional(
    Type.String({ description: "ISO 8601 due datetime, e.g. `2026-12-31T17:00:00Z`" }),
  ),
  status: Type.Optional(
    Type.String({
      description:
        "Task status (workspace-defined enum, e.g. TODO, IN_PROGRESS, DONE)",
    }),
  ),
  assigneeId: Type.Optional(
    Type.String({ description: "UUID of the workspace member assigned to the task" }),
  ),
});

const TaskUpdateSchema = Type.Object({
  id: Type.String({ description: "Task UUID to update" }),
  title: Type.Optional(Type.String()),
  bodyV2: Type.Optional(TaskBodySchema),
  dueAt: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  assigneeId: Type.Optional(Type.String()),
});

export function buildTasksTools(client: TwentyClient) {
  return [
    buildListTool<TwentyTask>(client, {
      name: "twenty_tasks_list",
      description:
        "List tasks from the Twenty workspace, paginated. Returns up to " +
        "`limit` records (default 60, max 200). Use `pageInfo.endCursor` + " +
        "`starting_after` to fetch the next page. " +
        "Filter examples: `status[eq]:TODO`, `dueAt[lte]:2026-12-31`. " +
        "To list tasks attached to a specific person/company/opportunity, " +
        "use `twenty_activities_list_for` instead — it joins via taskTargets.",
      path: "/rest/tasks",
      entityKey: "tasks",
    }),

    buildCreateTool<typeof TaskCreateSchema, TwentyTask>(client, {
      name: "twenty_tasks_create",
      description:
        "Create a new standalone task. Pass `title`, `bodyV2.markdown`, " +
        "`dueAt`, `status`, `assigneeId`. To attach the task to a " +
        "Person/Company/Opportunity, follow up with a `twenty_activities_*` " +
        "tool that creates a taskTarget — direct attachment is not " +
        "supported here yet. Returns the created Task record.",
      path: "/rest/tasks",
      entityKeySingular: "task",
      bodySchema: TaskCreateSchema,
    }),

    buildUpdateTool<typeof TaskUpdateSchema, TwentyTask>(client, {
      name: "twenty_tasks_update",
      description:
        "Update an existing task by UUID. Only the fields supplied in the " +
        "body are modified (PATCH semantics). `id` is required. Returns " +
        "the updated Task record.",
      path: "/rest/tasks",
      entityKeySingular: "task",
      bodySchema: TaskUpdateSchema,
    }),

    buildDeleteTool(client, {
      name: "twenty_tasks_delete",
      description:
        "Soft-delete a task by UUID. The record is kept in the database " +
        "with a `deletedAt` timestamp and is no longer returned by " +
        "`twenty_tasks_list`. Recoverable through the Twenty UI (REST " +
        "restore endpoint is broken upstream). " +
        "This tool requires approval by default (see `approvalRequired`).",
      path: "/rest/tasks",
      entityKeySingular: "task",
    }),
  ];
}
