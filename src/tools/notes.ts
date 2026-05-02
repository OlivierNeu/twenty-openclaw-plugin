// Twenty Notes (`/notes`) read tools.
//
// Verified against the Twenty REST OpenAPI:
//   - GET /notes → { data: { notes: [...] }, pageInfo, totalCount }
//
// P2 ships the list endpoint only; the get-by-id, create, update, and
// delete tools land in P3.

import { buildListTool } from "./_factory.js";
import type { TwentyClient } from "../twenty-client.js";
import type { TwentyNote } from "../types.js";

export function buildNotesTools(client: TwentyClient) {
  return [
    buildListTool<TwentyNote>(client, {
      name: "twenty_notes_list",
      description:
        "List notes from the Twenty workspace, paginated. Returns up to " +
        "`limit` records (default 60, max 200). Use `pageInfo.endCursor` + " +
        "`starting_after` to fetch the next page. " +
        "To list notes attached to a specific person/company/opportunity, " +
        "use `twenty_activities_list_for` instead — it joins via noteTargets.",
      path: "/rest/notes",
      entityKey: "notes",
    }),
  ];
}
