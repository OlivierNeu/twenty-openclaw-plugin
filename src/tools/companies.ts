// Twenty Companies (`/companies`) read tools.
//
// Verified against the Twenty REST OpenAPI:
//   - GET /companies        → { data: { companies: [...] }, pageInfo, totalCount }
//   - GET /companies/{id}   → { data: { company: {...} } }
//
// Both endpoints share the standard list/get factories — see
// `_factory.ts` for the unwrap and pagination contract.

import { buildGetByIdTool, buildListTool } from "./_factory.js";
import type { TwentyClient } from "../twenty-client.js";
import type { TwentyCompany } from "../types.js";

export function buildCompaniesTools(client: TwentyClient) {
  return [
    buildListTool<TwentyCompany>(client, {
      name: "twenty_companies_list",
      description:
        "List companies from the Twenty workspace, paginated. Returns up " +
        "to `limit` records (default 60, max 200). Use `pageInfo.endCursor` " +
        "+ `starting_after` to fetch the next page. " +
        "Filter examples: `name[ilike]:%acme%`, " +
        "`domainName.primaryLinkUrl[ilike]:%acme.com%`, " +
        "`employees[gte]:50`.",
      path: "/companies",
      entityKey: "companies",
    }),

    buildGetByIdTool<TwentyCompany>(client, {
      name: "twenty_companies_get",
      description:
        "Fetch a single company by UUID. Includes direct relations " +
        "(domain, address, ...) when `depth=1` (default).",
      path: "/companies",
      entityKeySingular: "company",
    }),
  ];
}
