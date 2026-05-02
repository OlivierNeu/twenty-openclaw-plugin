// Twenty Tasks (`/tasks`) read tools.
//
// Verified against the Twenty REST OpenAPI:
//   - GET /tasks → { data: { tasks: [...] }, pageInfo, totalCount }
//
// P2 ships the list endpoint only; the get-by-id, create, update, and
// delete tools land in P3.

import { buildListTool } from "./_factory.js";
import type { TwentyClient } from "../twenty-client.js";
import type { TwentyTask } from "../types.js";

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
  ];
}
