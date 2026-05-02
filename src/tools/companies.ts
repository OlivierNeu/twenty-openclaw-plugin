// Twenty Companies (`/rest/companies`) read + write tools.
//
// Verified against the Twenty REST OpenAPI:
//   - GET    /companies         → { data: { companies: [...] }, pageInfo, totalCount }
//   - GET    /companies/{id}    → { data: { company: {...} } }
//   - POST   /companies         → 201 { data: { createCompany: {...} } }
//   - PATCH  /companies/{id}    → 200 { data: { updateCompany: {...} } }
//   - DELETE /companies/{id}    → 200 { data: { deleteCompany: { id } } }
//
// All endpoints share the standard list/get/create/update/delete factories.

import { Type } from "@sinclair/typebox";

import {
  buildCreateTool,
  buildDeleteTool,
  buildGetByIdTool,
  buildListTool,
  buildUpdateTool,
} from "./_factory.js";
import type { TwentyClient } from "../twenty-client.js";
import type { TwentyCompany } from "../types.js";

// Twenty wraps the company website inside a `domainName` object. We only
// surface `primaryLinkUrl` to keep the schema slim — multi-link companies
// can be edited via the UI for now.
const DomainNameSchema = Type.Object({
  primaryLinkUrl: Type.Optional(Type.String()),
  primaryLinkLabel: Type.Optional(Type.String()),
});

// Address is also an object with city/postcode/state/country — we expose
// the structured fields directly so the agent can fill what it has.
const AddressSchema = Type.Object({
  addressStreet1: Type.Optional(Type.String()),
  addressStreet2: Type.Optional(Type.String()),
  addressCity: Type.Optional(Type.String()),
  addressPostcode: Type.Optional(Type.String()),
  addressState: Type.Optional(Type.String()),
  addressCountry: Type.Optional(Type.String()),
});

const CompanyCreateSchema = Type.Object({
  name: Type.Optional(Type.String({ description: "Company name" })),
  domainName: Type.Optional(DomainNameSchema),
  address: Type.Optional(AddressSchema),
  employees: Type.Optional(
    Type.Integer({ description: "Number of employees" }),
  ),
  idealCustomerProfile: Type.Optional(Type.Boolean()),
  accountOwnerId: Type.Optional(
    Type.String({ description: "UUID of the workspace member who owns the account" }),
  ),
});

const CompanyUpdateSchema = Type.Object({
  id: Type.String({ description: "Company UUID to update" }),
  name: Type.Optional(Type.String()),
  domainName: Type.Optional(DomainNameSchema),
  address: Type.Optional(AddressSchema),
  employees: Type.Optional(Type.Integer()),
  idealCustomerProfile: Type.Optional(Type.Boolean()),
  accountOwnerId: Type.Optional(Type.String()),
});

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
      path: "/rest/companies",
      entityKey: "companies",
    }),

    buildGetByIdTool<TwentyCompany>(client, {
      name: "twenty_companies_get",
      description:
        "Fetch a single company by UUID. Includes direct relations " +
        "(domain, address, ...) when `depth=1` (default).",
      path: "/rest/companies",
      entityKeySingular: "company",
    }),

    buildCreateTool<typeof CompanyCreateSchema, TwentyCompany>(client, {
      name: "twenty_companies_create",
      description:
        "Create a new company in the Twenty workspace. Pass `name`, " +
        "`domainName.primaryLinkUrl` (website), `address.*` (street/city/...), " +
        "`employees`, `idealCustomerProfile`, `accountOwnerId`. All optional. " +
        "Returns the created Company record.",
      path: "/rest/companies",
      entityKeySingular: "company",
      bodySchema: CompanyCreateSchema,
    }),

    buildUpdateTool<typeof CompanyUpdateSchema, TwentyCompany>(client, {
      name: "twenty_companies_update",
      description:
        "Update an existing company by UUID. Only the fields supplied in " +
        "the body are modified (PATCH semantics). `id` is required. " +
        "Returns the updated Company record.",
      path: "/rest/companies",
      entityKeySingular: "company",
      bodySchema: CompanyUpdateSchema,
    }),

    buildDeleteTool(client, {
      name: "twenty_companies_delete",
      description:
        "Soft-delete a company by UUID. The record is kept in the database " +
        "with a `deletedAt` timestamp and is no longer returned by " +
        "`twenty_companies_list` / `twenty_companies_get`. Recoverable via " +
        "the Twenty UI or a future `twenty_companies_restore` tool. " +
        "This tool requires approval by default (see `approvalRequired`).",
      path: "/rest/companies",
      entityKeySingular: "company",
    }),
  ];
}
