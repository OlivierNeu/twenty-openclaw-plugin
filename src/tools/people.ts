// Twenty People (`/people`) read tools.
//
// Verified against the Twenty REST OpenAPI:
//   - GET /people           → { data: { people: [...] }, pageInfo, totalCount }
//   - GET /people/{id}      → { data: { person: {...} } }
//
// Both endpoints share the standard list/get factories — see
// `_factory.ts` for the unwrap and pagination contract.

import { buildGetByIdTool, buildListTool } from "./_factory.js";
import type { TwentyClient } from "../twenty-client.js";
import type { TwentyPerson } from "../types.js";

export function buildPeopleTools(client: TwentyClient) {
  return [
    buildListTool<TwentyPerson>(client, {
      name: "twenty_people_list",
      description:
        "List people from the Twenty workspace, paginated. Returns up to " +
        "`limit` records (default 60, max 200). Use `pageInfo.endCursor` + " +
        "`starting_after` to fetch the next page. " +
        "Filter examples: `firstName[eq]:John`, " +
        "`emails.primaryEmail[ilike]:%@acme.com%`, " +
        "`createdAt[gte]:2026-01-01`.",
      path: "/rest/people",
      entityKey: "people",
    }),

    buildGetByIdTool<TwentyPerson>(client, {
      name: "twenty_people_get",
      description:
        "Fetch a single person by UUID. Includes direct relations " +
        "(emails, phones, company link, ...) when `depth=1` (default).",
      path: "/rest/people",
      entityKeySingular: "person",
    }),
  ];
}
