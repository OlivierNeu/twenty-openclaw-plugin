// Field configuration tools — Surface 3 of the v0.8.0 plugin extension.
//
// Ergonomic wrappers on top of `updateOneField` for the field-level
// settings the agent needs to manipulate atomically: SELECT options,
// type-specific settings (CURRENCY decimals, RATING max, NUMBER
// format, RICH_TEXT toolbar, RELATION onDelete, ...), default values,
// and the boolean constraints (isNullable / isUnique / isUIReadOnly /
// isActive). `twenty_metadata_field_update` (existing P5 tool) covers
// the same Twenty mutation but expects the agent to know the input
// shape — these wrappers are easier to invoke for the LLM.
//
// Every mutation routes through Twenty's `updateOneField(input: {
// id, update: { ... } })` shape (verified live against Twenty 2.1's
// `__type(name: "UpdateFieldInput")` introspection).

import { Type } from "@sinclair/typebox";

import { defineTwentyTool } from "./_factory.js";
import type { TwentyClient } from "../twenty-client.js";

interface FieldResp {
  id: string;
  name: string;
  label: string;
  type: string;
  isActive: boolean | null;
  isNullable: boolean | null;
  isUnique: boolean | null;
  isUIReadOnly: boolean | null;
  defaultValue: unknown;
  options: unknown;
  settings: unknown;
}

const FIELD_FRAGMENT = `
  id name label description icon type
  isActive isNullable isUnique isUIReadOnly isLabelSyncedWithName
  defaultValue options settings
  objectMetadataId
`;

const FieldIdParam = Type.Object({
  fieldMetadataId: Type.String({ description: "Field metadata UUID" }),
});

const SetOptionsSchema = Type.Object({
  fieldMetadataId: Type.String(),
  options: Type.Array(
    Type.Object({
      id: Type.Optional(
        Type.String({
          description:
            "Option UUID — supply when editing an existing option. " +
            "Omit to create a new option (Twenty assigns a UUID).",
        }),
      ),
      label: Type.String({ description: "Display label" }),
      value: Type.String({ description: "Stored value (typically UPPER_SNAKE)" }),
      color: Type.Optional(
        Type.String({
          description:
            "Tailwind palette name: red / orange / yellow / green / " +
            "turquoise / sky / blue / purple / pink / gray (Twenty default).",
        }),
      ),
      position: Type.Optional(Type.Number()),
      isDefault: Type.Optional(Type.Boolean()),
    }),
    {
      minItems: 0,
      description:
        "Full replacement set of options. Anything not listed is " +
        "removed. For SELECT and MULTI_SELECT fields only — Twenty " +
        "ignores `options` on other types.",
    },
  ),
});

const SetSettingsSchema = Type.Object({
  fieldMetadataId: Type.String(),
  settings: Type.Any({
    description:
      "Type-specific settings JSON object. Examples:\n" +
      "  CURRENCY → { currencyCode: 'EUR', decimals: 2 }\n" +
      "  RATING   → { maxValue: 5 }\n" +
      "  NUMBER   → { format: 'percentage' | 'number' | 'shortNumber', decimals: 0 }\n" +
      "  RICH_TEXT → { toolbar: ['bold','italic',...] }\n" +
      "  RELATION → { onDelete: 'CASCADE' | 'SET_NULL' | 'RESTRICT' }\n" +
      "Pass null to clear all settings. The plugin forwards the JSON " +
      "verbatim — Twenty validates it server-side.",
  }),
});

const SetDefaultSchema = Type.Object({
  fieldMetadataId: Type.String(),
  defaultValue: Type.Any({
    description:
      "JSON value used as the field's default. Type depends on field " +
      "type (string for TEXT, number for NUMBER, boolean for BOOLEAN, " +
      "string for SELECT/MULTI_SELECT matching an option's value, " +
      "ISO date string for DATE/DATE_TIME, etc.). Pass null to clear " +
      "the default.",
  }),
});

const SetConstraintsSchema = Type.Object({
  fieldMetadataId: Type.String(),
  isNullable: Type.Optional(
    Type.Boolean({
      description:
        "When false, Twenty rejects records that omit this field. " +
        "Changing nullable=false on an existing field with NULL rows " +
        "may fail at the DB level — back-fill first.",
    }),
  ),
  isUnique: Type.Optional(
    Type.Boolean({
      description:
        "Adds (or removes) a unique constraint at the DB level. " +
        "Toggling on with duplicates present will fail.",
    }),
  ),
  isUIReadOnly: Type.Optional(
    Type.Boolean({
      description:
        "Hides the edit affordance in the Twenty UI. Records can still " +
        "be modified through the API.",
    }),
  ),
  isActive: Type.Optional(
    Type.Boolean({
      description:
        "Soft-disables the field (hidden everywhere). Prefer " +
        "twenty_metadata_field_delete for explicit removal.",
    }),
  ),
});

const SetRelationSettingsSchema = Type.Object({
  fieldMetadataId: Type.String(),
  onDelete: Type.Union(
    [
      Type.Literal("CASCADE"),
      Type.Literal("SET_NULL"),
      Type.Literal("RESTRICT"),
      Type.Literal("NO_ACTION"),
    ],
    {
      description:
        "Behavior when the related record is deleted. CASCADE = delete " +
        "this record too. SET_NULL = keep the record but null the FK. " +
        "RESTRICT / NO_ACTION = forbid deletion of the related record " +
        "while this FK exists.",
    },
  ),
  inverseLabel: Type.Optional(
    Type.String({
      description:
        "Label of the inverse side (e.g. RELATION mission → company " +
        "may have inverseLabel='Missions' on Company). The plugin " +
        "merges this into the field's `settings.relationLabel`.",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Helper to issue updateOneField with a partial `update` patch.
// ---------------------------------------------------------------------------

async function patchField(
  client: TwentyClient,
  fieldMetadataId: string,
  update: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<FieldResp> {
  const data = await client.postGraphQL<{ updateOneField: FieldResp }>(
    `mutation FieldPatch($input: UpdateOneFieldMetadataInput!) {
      updateOneField(input: $input) { ${FIELD_FRAGMENT} }
    }`,
    { input: { id: fieldMetadataId, update } },
    { signal },
  );
  return data.updateOneField;
}

// ---------------------------------------------------------------------------
// Tool builder.
// ---------------------------------------------------------------------------

export function buildFieldConfigTools(client: TwentyClient) {
  return [
    defineTwentyTool(
      {
        name: "twenty_metadata_field_options_set",
        description:
          "Replace the option list of a SELECT or MULTI_SELECT field " +
          "atomically. Pass the FULL set of options — anything missing " +
          "from the array is REMOVED. Each option requires `label` and " +
          "`value`; supply an existing `id` to keep that option's " +
          "history (records using it stay valid). Approval-gated by " +
          "default through twenty_metadata_field_update's gate.",
        mutates: true,
        parameters: SetOptionsSchema,
        run: async (params, c, signal) => {
          return patchField(
            c,
            params.fieldMetadataId,
            { options: params.options },
            signal,
          );
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_metadata_field_settings_set",
        description:
          "Replace the type-specific `settings` JSON of a field. The " +
          "plugin forwards the object verbatim — Twenty validates it " +
          "based on the field type. See the schema description for the " +
          "common shapes per type.",
        mutates: true,
        parameters: SetSettingsSchema,
        run: async (params, c, signal) => {
          return patchField(
            c,
            params.fieldMetadataId,
            { settings: params.settings },
            signal,
          );
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_metadata_field_default_set",
        description:
          "Set (or clear, when `defaultValue` is null) the default " +
          "value of a field. New records that omit this field will use " +
          "the supplied value. Type must match the field type.",
        mutates: true,
        parameters: SetDefaultSchema,
        run: async (params, c, signal) => {
          return patchField(
            c,
            params.fieldMetadataId,
            { defaultValue: params.defaultValue },
            signal,
          );
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_metadata_field_constraints_set",
        description:
          "Patch the boolean constraints of a field (isNullable, " +
          "isUnique, isUIReadOnly, isActive). All four are optional — " +
          "only the supplied flags are modified. Toggling isNullable=" +
          "false or isUnique=true may fail when existing data violates " +
          "the new constraint; back-fill / dedup first.",
        mutates: true,
        parameters: SetConstraintsSchema,
        run: async (params, c, signal) => {
          const { fieldMetadataId, ...flags } = params;
          return patchField(c, fieldMetadataId, flags, signal);
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_metadata_field_relation_settings_set",
        description:
          "Patch the RELATION-specific settings of a field: onDelete " +
          "behavior (CASCADE / SET_NULL / RESTRICT / NO_ACTION) and " +
          "optional inverseLabel. Twenty's `settings` field is " +
          "replace-on-update — this tool sends only the relation-scoped " +
          "keys, so any pre-existing non-relation settings are cleared. " +
          "When merging with other settings is needed, use " +
          "twenty_metadata_field_settings_set with the full object.",
        mutates: true,
        parameters: SetRelationSettingsSchema,
        run: async (params, c, signal) => {
          const newSettings: Record<string, unknown> = {
            onDelete: params.onDelete,
          };
          if (params.inverseLabel !== undefined) {
            newSettings.relationLabel = params.inverseLabel;
          }
          return patchField(
            c,
            params.fieldMetadataId,
            { settings: newSettings },
            signal,
          );
        },
      },
      client,
    ),
  ];
}

// Re-export so external callers (tests, downstream tools) can reference
// the param schemas without introspecting at runtime.
export {
  FieldIdParam,
  SetOptionsSchema,
  SetSettingsSchema,
  SetDefaultSchema,
  SetConstraintsSchema,
  SetRelationSettingsSchema,
};
