// Twenty Opportunities (`/opportunities`) read tools.
//
// Verified against the Twenty REST OpenAPI:
//   - GET /opportunities          → { data: { opportunities: [...] }, pageInfo, totalCount }
//   - GET /opportunities/{id}     → { data: { opportunity: {...} } }
//
// Both endpoints share the standard list/get factories — see
// `_factory.ts` for the unwrap and pagination contract.

import { buildGetByIdTool, buildListTool } from "./_factory.js";
import type { TwentyClient } from "../twenty-client.js";
import type { TwentyOpportunity } from "../types.js";

export function buildOpportunitiesTools(client: TwentyClient) {
  return [
    buildListTool<TwentyOpportunity>(client, {
      name: "twenty_opportunities_list",
      description:
        "List opportunities (deals) from the Twenty workspace, paginated. " +
        "Returns up to `limit` records (default 60, max 200). Use " +
        "`pageInfo.endCursor` + `starting_after` to fetch the next page. " +
        "Filter examples: `stage[eq]:NEW`, `amount.amountMicros[gte]:1000000000`, " +
        "`closeDate[lte]:2026-12-31`.",
      path: "/rest/opportunities",
      entityKey: "opportunities",
    }),

    buildGetByIdTool<TwentyOpportunity>(client, {
      name: "twenty_opportunities_get",
      description:
        "Fetch a single opportunity by UUID. Includes direct relations " +
        "(amount, stage, point of contact, company, ...) when `depth=1` " +
        "(default).",
      path: "/rest/opportunities",
      entityKeySingular: "opportunity",
    }),
  ];
}
