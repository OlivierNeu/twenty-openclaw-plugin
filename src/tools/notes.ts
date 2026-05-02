// Twenty Notes (`/rest/notes`) read + write tools.
//
// Verified against the Twenty REST OpenAPI:
//   - GET    /notes         → { data: { notes: [...] }, pageInfo, totalCount }
//   - POST   /notes         → 201 { data: { createNote: {...} } }
//   - PATCH  /notes/{id}    → 200 { data: { updateNote: {...} } }
//   - DELETE /notes/{id}    → 200 { data: { deleteNote: { id } } }
//
// `twenty_activities_list_for` is the preferred way to list notes attached
// to a specific person/company/opportunity (it joins via noteTargets).

import { Type } from "@sinclair/typebox";

import {
  buildCreateTool,
  buildDeleteTool,
  buildListTool,
  buildUpdateTool,
} from "./_factory.js";
import type { TwentyClient } from "../twenty-client.js";
import type { TwentyNote } from "../types.js";

// Twenty stores note bodies in BlockNote rich-text format. The agent can
// supply markdown via `bodyV2.markdown` and Twenty converts on the fly.
const NoteBodySchema = Type.Object({
  markdown: Type.Optional(
    Type.String({
      description:
        "Note body as markdown. Twenty converts to its rich-text format internally.",
    }),
  ),
  blocknote: Type.Optional(
    Type.String({
      description: "Note body as BlockNote JSON (advanced — prefer markdown).",
    }),
  ),
});

const NoteCreateSchema = Type.Object({
  title: Type.Optional(Type.String({ description: "Note title" })),
  bodyV2: Type.Optional(NoteBodySchema),
});

const NoteUpdateSchema = Type.Object({
  id: Type.String({ description: "Note UUID to update" }),
  title: Type.Optional(Type.String()),
  bodyV2: Type.Optional(NoteBodySchema),
});

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

    buildCreateTool<typeof NoteCreateSchema, TwentyNote>(client, {
      name: "twenty_notes_create",
      description:
        "Create a new standalone note. Pass `title` and/or " +
        "`bodyV2.markdown`. To attach the note to a Person/Company/" +
        "Opportunity, follow up with a `twenty_activities_*` tool that " +
        "creates a noteTarget — direct attachment is not supported here yet. " +
        "Returns the created Note record.",
      path: "/rest/notes",
      entityKeySingular: "note",
      bodySchema: NoteCreateSchema,
    }),

    buildUpdateTool<typeof NoteUpdateSchema, TwentyNote>(client, {
      name: "twenty_notes_update",
      description:
        "Update an existing note by UUID. Only the fields supplied in the " +
        "body are modified (PATCH semantics). `id` is required. Returns " +
        "the updated Note record.",
      path: "/rest/notes",
      entityKeySingular: "note",
      bodySchema: NoteUpdateSchema,
    }),

    buildDeleteTool(client, {
      name: "twenty_notes_delete",
      description:
        "Soft-delete a note by UUID. The record is kept in the database " +
        "with a `deletedAt` timestamp and is no longer returned by " +
        "`twenty_notes_list`. Recoverable via the Twenty UI or a future " +
        "`twenty_notes_restore` tool. " +
        "This tool requires approval by default (see `approvalRequired`).",
      path: "/rest/notes",
      entityKeySingular: "note",
    }),
  ];
}
