// Twenty Opportunities (`/rest/opportunities`) read + write tools.
//
// Verified against the Twenty REST OpenAPI:
//   - GET    /opportunities                  → { data: { opportunities: [...] }, pageInfo, totalCount }
//   - GET    /opportunities/{id}             → { data: { opportunity: {...} } }
//   - POST   /opportunities                  → 201 { data: { createOpportunity: {...} } }
//   - PATCH  /opportunities/{id}             → 200 { data: { updateOpportunity: {...} } }
//   - DELETE /opportunities/{id}             → 200 { data: { deleteOpportunity: { id } } }
//
// Restore was prototyped in P4a but dropped — see comments in people.ts.

import { Type } from "@sinclair/typebox";

import {
  buildCreateTool,
  buildDeleteTool,
  buildGetByIdTool,
  buildListTool,
  buildUpdateTool,
} from "./_factory.js";
import type { TwentyClient } from "../twenty-client.js";
import type { TwentyOpportunity } from "../types.js";

// Twenty stores monetary amounts in micro-units (1 EUR = 1_000_000 micros)
// to avoid floating-point rounding. The agent passes both fields and lets
// Twenty normalise — keeping the schema close to the wire format.
const AmountSchema = Type.Object({
  amountMicros: Type.Optional(
    Type.Integer({
      description:
        "Amount in micros (1 EUR = 1_000_000 amountMicros). E.g. 1500000000 for 1500 EUR.",
    }),
  ),
  currencyCode: Type.Optional(
    Type.String({ description: "ISO 4217 currency code, e.g. `USD`, `EUR`" }),
  ),
});

const OpportunityCreateSchema = Type.Object({
  name: Type.Optional(Type.String({ description: "Opportunity name" })),
  amount: Type.Optional(AmountSchema),
  closeDate: Type.Optional(
    Type.String({ description: "ISO 8601 date or datetime" }),
  ),
  stage: Type.Optional(
    Type.String({
      description:
        "Opportunity pipeline stage (workspace-defined enum, e.g. NEW, SCREENING, MEETING, ...)",
    }),
  ),
  companyId: Type.Optional(
    Type.String({ description: "UUID of the linked company" }),
  ),
  pointOfContactId: Type.Optional(
    Type.String({ description: "UUID of the linked person (point of contact)" }),
  ),
  ownerId: Type.Optional(
    Type.String({ description: "UUID of the workspace member who owns the deal" }),
  ),
});

const OpportunityUpdateSchema = Type.Object({
  id: Type.String({ description: "Opportunity UUID to update" }),
  name: Type.Optional(Type.String()),
  amount: Type.Optional(AmountSchema),
  closeDate: Type.Optional(Type.String()),
  stage: Type.Optional(Type.String()),
  companyId: Type.Optional(Type.String()),
  pointOfContactId: Type.Optional(Type.String()),
  ownerId: Type.Optional(Type.String()),
});

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

    buildCreateTool<typeof OpportunityCreateSchema, TwentyOpportunity>(client, {
      name: "twenty_opportunities_create",
      description:
        "Create a new opportunity (deal) in the Twenty workspace. Pass " +
        "`name`, `amount.amountMicros` + `amount.currencyCode`, `closeDate`, " +
        "`stage`, `companyId`, `pointOfContactId`, `ownerId`. All optional. " +
        "Amounts are stored in micros (1 EUR = 1_000_000). Returns the created " +
        "Opportunity record.",
      path: "/rest/opportunities",
      entityKeySingular: "opportunity",
      bodySchema: OpportunityCreateSchema,
    }),

    buildUpdateTool<typeof OpportunityUpdateSchema, TwentyOpportunity>(client, {
      name: "twenty_opportunities_update",
      description:
        "Update an existing opportunity by UUID. Only the fields supplied " +
        "in the body are modified (PATCH semantics). `id` is required. " +
        "Returns the updated Opportunity record.",
      path: "/rest/opportunities",
      entityKeySingular: "opportunity",
      bodySchema: OpportunityUpdateSchema,
    }),

    buildDeleteTool(client, {
      name: "twenty_opportunities_delete",
      description:
        "Soft-delete an opportunity by UUID. The record is kept in the " +
        "database with a `deletedAt` timestamp and is no longer returned " +
        "by `twenty_opportunities_list` / `twenty_opportunities_get`. " +
        "Recoverable through the Twenty UI (REST restore endpoint is " +
        "broken upstream). " +
        "This tool requires approval by default (see `approvalRequired`).",
      path: "/rest/opportunities",
      entityKeySingular: "opportunity",
    }),
  ];
}
