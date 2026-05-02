// Twenty People (`/rest/people`) read + write tools.
//
// Verified against the Twenty REST OpenAPI:
//   - GET    /people                  → { data: { people: [...] }, pageInfo, totalCount }
//   - GET    /people/{id}             → { data: { person: {...} } }
//   - POST   /people                  → 201 { data: { createPerson: {...} } }
//   - PATCH  /people/{id}             → 200 { data: { updatePerson: {...} } }
//   - DELETE /people/{id}             → 200 { data: { deletePerson: { id } } }
//
// All endpoints share the standard list/get/create/update/delete factories
// — see `_factory.ts` for the unwrap, write, and read-only contracts.
//
// Restore (`PATCH /restore/people/{id}`) was prototyped in P4a but dropped:
// Twenty 2.1 declares the route in the REST OpenAPI yet returns 400
// BadRequest at runtime, with no GraphQL fallback. We will reintroduce
// the tool once upstream fixes the path; reconstruct from the git history
// at tag v0.2.0 (commit e952a2c).
//
// Body schema covers the fields most commonly edited by humans (name,
// emails, jobTitle, city, companyId). Twenty supports many more fields
// (linkedinLink, xLink, phones, ...) — they can be added later without
// breaking the existing tool surface.

import { Type } from "@sinclair/typebox";

import {
  buildCreateTool,
  buildDeleteTool,
  buildGetByIdTool,
  buildListTool,
  buildUpdateTool,
} from "./_factory.js";
import type { TwentyClient } from "../twenty-client.js";
import type { TwentyPerson } from "../types.js";

// Shared sub-schemas — Twenty wraps the contact name and emails in nested
// objects (matching the metadata returned by `twenty_workspace_info`).
const PersonNameSchema = Type.Object({
  firstName: Type.Optional(Type.String()),
  lastName: Type.Optional(Type.String()),
});

const PersonEmailsSchema = Type.Object({
  primaryEmail: Type.Optional(Type.String({ format: "email" })),
  additionalEmails: Type.Optional(
    Type.Array(Type.String({ format: "email" })),
  ),
});

// Create body: every field is optional — Twenty accepts an empty Person
// (it will fill name/companyId from defaults). Keeping the schema permissive
// matches OpenAPI's stance that no field is `required`.
const PersonCreateSchema = Type.Object({
  name: Type.Optional(PersonNameSchema),
  emails: Type.Optional(PersonEmailsSchema),
  jobTitle: Type.Optional(Type.String()),
  city: Type.Optional(Type.String()),
  companyId: Type.Optional(
    Type.String({ description: "UUID of the linked company, if any" }),
  ),
});

// Update body: same shape as create plus the required `id`. Top-level
// `additionalProperties: false` is left off so the agent can include
// extra Twenty-specific fields the schema doesn't list (the API will
// reject anything truly invalid).
const PersonUpdateSchema = Type.Object({
  id: Type.String({ description: "Person UUID to update" }),
  name: Type.Optional(PersonNameSchema),
  emails: Type.Optional(PersonEmailsSchema),
  jobTitle: Type.Optional(Type.String()),
  city: Type.Optional(Type.String()),
  companyId: Type.Optional(
    Type.String({ description: "UUID of the linked company, if any" }),
  ),
});

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

    buildCreateTool<typeof PersonCreateSchema, TwentyPerson>(client, {
      name: "twenty_people_create",
      description:
        "Create a new person in the Twenty workspace. Pass `name.firstName`, " +
        "`name.lastName`, `emails.primaryEmail`, `jobTitle`, `city`, and/or " +
        "`companyId` (UUID of an existing company). All fields are optional. " +
        "Returns the created Person record.",
      path: "/rest/people",
      entityKeySingular: "person",
      bodySchema: PersonCreateSchema,
    }),

    buildUpdateTool<typeof PersonUpdateSchema, TwentyPerson>(client, {
      name: "twenty_people_update",
      description:
        "Update an existing person by UUID. Only the fields supplied in the " +
        "body are modified (PATCH semantics). `id` is required. Returns the " +
        "updated Person record.",
      path: "/rest/people",
      entityKeySingular: "person",
      bodySchema: PersonUpdateSchema,
    }),

    buildDeleteTool(client, {
      name: "twenty_people_delete",
      description:
        "Soft-delete a person by UUID. The record is kept in the database " +
        "with a `deletedAt` timestamp and is no longer returned by " +
        "`twenty_people_list` / `twenty_people_get`. Recoverable through " +
        "the Twenty UI (the REST restore endpoint is broken upstream). " +
        "This tool requires approval by default (see `approvalRequired`).",
      path: "/rest/people",
      entityKeySingular: "person",
    }),
  ];
}
