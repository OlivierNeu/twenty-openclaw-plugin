// TypeBox schemas for Twenty workflows.
//
// Direct port of the canonical Zod schemas in
// `packages/twenty-shared/src/workflow/schemas/` (Twenty 2.1+). Mirrors
// the contract Twenty's own LLM tools use, so the OpenClaw agent gets
// the same authoring surface.
//
// Twenty stores `trigger` and `steps` as JSON columns and validates
// server-side; these schemas are primarily for the LLM's benefit.
// Where Twenty's Zod is permissive (e.g. `z.record(z.string(), z.any())`,
// `looseObject({})`) we use `Type.Any()` / `additionalProperties: true`
// to match.

import { Type, type Static } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Enum unions — sourced from twenty-server WorkflowTriggerType /
// WorkflowActionType / WorkflowStatus / WorkflowVersionStatus /
// WorkflowRunStatus.
// ---------------------------------------------------------------------------

export const WorkflowTriggerTypeSchema = Type.Union([
  Type.Literal("DATABASE_EVENT"),
  Type.Literal("MANUAL"),
  Type.Literal("CRON"),
  Type.Literal("WEBHOOK"),
]);

export const WorkflowActionTypeSchema = Type.Union([
  Type.Literal("CODE"),
  Type.Literal("LOGIC_FUNCTION"),
  Type.Literal("SEND_EMAIL"),
  Type.Literal("DRAFT_EMAIL"),
  Type.Literal("CREATE_RECORD"),
  Type.Literal("UPDATE_RECORD"),
  Type.Literal("DELETE_RECORD"),
  Type.Literal("UPSERT_RECORD"),
  Type.Literal("FIND_RECORDS"),
  Type.Literal("FORM"),
  Type.Literal("FILTER"),
  Type.Literal("IF_ELSE"),
  Type.Literal("HTTP_REQUEST"),
  Type.Literal("AI_AGENT"),
  Type.Literal("ITERATOR"),
  Type.Literal("EMPTY"),
  Type.Literal("DELAY"),
]);

export const WorkflowStatusSchema = Type.Union([
  Type.Literal("DRAFT"),
  Type.Literal("ACTIVE"),
  Type.Literal("DEACTIVATED"),
]);

export const WorkflowVersionStatusSchema = Type.Union([
  Type.Literal("DRAFT"),
  Type.Literal("ACTIVE"),
  Type.Literal("DEACTIVATED"),
  Type.Literal("ARCHIVED"),
]);

export const WorkflowRunStatusSchema = Type.Union([
  Type.Literal("NOT_STARTED"),
  Type.Literal("ENQUEUED"),
  Type.Literal("RUNNING"),
  Type.Literal("COMPLETED"),
  Type.Literal("FAILED"),
  Type.Literal("STOPPING"),
  Type.Literal("STOPPED"),
]);

// ---------------------------------------------------------------------------
// Step / trigger position in the visual builder.
// ---------------------------------------------------------------------------

const PositionSchema = Type.Object({
  x: Type.Number(),
  y: Type.Number(),
});

// ---------------------------------------------------------------------------
// Trigger settings — discriminated by `type`. Twenty stores this as a JSON
// blob; we expose a typed schema per branch so the LLM can build a valid
// trigger without trial-and-error.
// ---------------------------------------------------------------------------

const DatabaseEventTriggerSettingsSchema = Type.Object({
  eventName: Type.String({
    description:
      "Event name in format `objectName.action`, lowercase. Action is " +
      "one of: created, updated, deleted, upserted. " +
      'Examples: "company.created", "person.updated", "task.deleted".',
    pattern: "^[a-z][a-zA-Z0-9_]*\\.(created|updated|deleted|upserted)$",
  }),
  outputSchema: Type.Object(
    {},
    {
      additionalProperties: true,
      description:
        "Output shape — the triggered record is accessible via " +
        "{{trigger.object.fieldName}}.",
    },
  ),
  input: Type.Optional(Type.Object({}, { additionalProperties: true })),
  objectType: Type.Optional(Type.String()),
  fields: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
});

const ManualTriggerAvailabilitySchema = Type.Union([
  Type.Object({
    type: Type.Literal("GLOBAL"),
    locations: Type.Optional(Type.Array(Type.String())),
  }),
  Type.Object({
    type: Type.Literal("SINGLE_RECORD"),
    objectNameSingular: Type.String(),
  }),
  Type.Object({
    type: Type.Literal("BULK_RECORDS"),
    objectNameSingular: Type.String(),
  }),
]);

const ManualTriggerSettingsSchema = Type.Object({
  outputSchema: Type.Object(
    {},
    {
      additionalProperties: true,
      description:
        "When a record is selected, accessible via {{trigger.record.fieldName}}.",
    },
  ),
  objectType: Type.Optional(Type.String()),
  icon: Type.Optional(Type.String()),
  isPinned: Type.Optional(Type.Boolean()),
  availability: Type.Optional(
    Type.Union([ManualTriggerAvailabilitySchema, Type.Null()]),
  ),
});

const CronDaysSchema = Type.Object({
  type: Type.Literal("DAYS"),
  schedule: Type.Object({
    day: Type.Integer({ minimum: 1 }),
    hour: Type.Integer({ minimum: 0, maximum: 23 }),
    minute: Type.Integer({ minimum: 0, maximum: 59 }),
  }),
  outputSchema: Type.Object({}, { additionalProperties: true }),
});

const CronHoursSchema = Type.Object({
  type: Type.Literal("HOURS"),
  schedule: Type.Object({
    hour: Type.Integer({ minimum: 1 }),
    minute: Type.Integer({ minimum: 0, maximum: 59 }),
  }),
  outputSchema: Type.Object({}, { additionalProperties: true }),
});

const CronMinutesSchema = Type.Object({
  type: Type.Literal("MINUTES"),
  schedule: Type.Object({
    minute: Type.Integer({ minimum: 1, maximum: 60 }),
  }),
  outputSchema: Type.Object({}, { additionalProperties: true }),
});

const CronCustomSchema = Type.Object({
  type: Type.Literal("CUSTOM"),
  pattern: Type.String({
    description:
      "Standard 5-field cron expression (e.g. '0 9 * * MON-FRI' for " +
      "weekdays at 9am).",
  }),
  outputSchema: Type.Object({}, { additionalProperties: true }),
});

const CronTriggerSettingsSchema = Type.Union([
  CronDaysSchema,
  CronHoursSchema,
  CronMinutesSchema,
  CronCustomSchema,
]);

const WebhookGetSchema = Type.Object({
  httpMethod: Type.Literal("GET"),
  authentication: Type.Union([Type.Literal("API_KEY"), Type.Null()]),
  outputSchema: Type.Object({}, { additionalProperties: true }),
});

const WebhookPostSchema = Type.Object({
  httpMethod: Type.Literal("POST"),
  authentication: Type.Union([Type.Literal("API_KEY"), Type.Null()]),
  expectedBody: Type.Object({}, { additionalProperties: true }),
  outputSchema: Type.Object({}, { additionalProperties: true }),
});

const WebhookTriggerSettingsSchema = Type.Union([
  WebhookGetSchema,
  WebhookPostSchema,
]);

// Discriminated union — typed by `type`. Loose at the discriminator boundary
// because TypeBox unions match by structure; Twenty validates server-side
// against the canonical Zod.
export const WorkflowTriggerSchema = Type.Union(
  [
    Type.Object({
      type: Type.Literal("DATABASE_EVENT"),
      name: Type.Optional(Type.String()),
      position: Type.Optional(Type.Union([PositionSchema, Type.Null()])),
      nextStepIds: Type.Optional(
        Type.Union([Type.Array(Type.String()), Type.Null()]),
      ),
      settings: DatabaseEventTriggerSettingsSchema,
    }),
    Type.Object({
      type: Type.Literal("MANUAL"),
      name: Type.Optional(Type.String()),
      position: Type.Optional(Type.Union([PositionSchema, Type.Null()])),
      nextStepIds: Type.Optional(
        Type.Union([Type.Array(Type.String()), Type.Null()]),
      ),
      settings: ManualTriggerSettingsSchema,
    }),
    Type.Object({
      type: Type.Literal("CRON"),
      name: Type.Optional(Type.String()),
      position: Type.Optional(Type.Union([PositionSchema, Type.Null()])),
      nextStepIds: Type.Optional(
        Type.Union([Type.Array(Type.String()), Type.Null()]),
      ),
      settings: CronTriggerSettingsSchema,
    }),
    Type.Object({
      type: Type.Literal("WEBHOOK"),
      name: Type.Optional(Type.String()),
      position: Type.Optional(Type.Union([PositionSchema, Type.Null()])),
      nextStepIds: Type.Optional(
        Type.Union([Type.Array(Type.String()), Type.Null()]),
      ),
      settings: WebhookTriggerSettingsSchema,
    }),
  ],
  {
    description:
      "Trigger discriminated by `type`. DATABASE_EVENT for record changes " +
      '(eventName like "company.created"), MANUAL for user-launched, ' +
      "CRON for scheduled (4 sub-types), WEBHOOK for external HTTP calls.",
  },
);

// ---------------------------------------------------------------------------
// Step filter schemas — used by FILTER and IF_ELSE actions.
// ---------------------------------------------------------------------------

export const StepFilterSchema = Type.Object({
  id: Type.String(),
  type: Type.String(),
  stepOutputKey: Type.String({
    description: "Path in the upstream step output (e.g. 'amount.amountMicros').",
  }),
  operand: Type.String({
    description:
      "ViewFilterOperand. Common values: 'is', 'isNot', 'contains', " +
      "'doesNotContain', 'isEmpty', 'isNotEmpty', 'isGreaterThan', " +
      "'isLessThan', 'isAfter', 'isBefore', 'is_in', 'is_not_in'.",
  }),
  value: Type.String({
    description:
      "Comparison value as a string (Twenty parses it per field type). " +
      "Supports {{trigger.x}} and {{step-id.result.x}} variable refs.",
  }),
  stepFilterGroupId: Type.String(),
  positionInStepFilterGroup: Type.Optional(Type.Integer()),
  fieldMetadataId: Type.Optional(Type.String()),
  compositeFieldSubFieldName: Type.Optional(Type.String()),
});

export const StepFilterGroupSchema = Type.Object({
  id: Type.String(),
  logicalOperator: Type.Union(
    [Type.Literal("AND"), Type.Literal("OR")],
    {
      description:
        "Boolean operator for combining filters in this group.",
    },
  ),
  parentStepFilterGroupId: Type.Optional(Type.String()),
  positionInStepFilterGroup: Type.Optional(Type.Integer()),
});

// ---------------------------------------------------------------------------
// Action settings — typed per action type. Each `input` shape mirrors
// twenty-shared/workflow/schemas/<action>-action-settings-schema.ts.
//
// `objectRecord` is `Type.Object({}, { additionalProperties: true })`
// because Twenty's objectRecordSchema is permissive (any record fields).
// ---------------------------------------------------------------------------

const ErrorHandlingOptionsSchema = Type.Object({
  retryOnFailure: Type.Object({ value: Type.Boolean() }),
  continueOnFailure: Type.Object({ value: Type.Boolean() }),
});

const BaseActionSettingsExtension = {
  outputSchema: Type.Object(
    {},
    {
      additionalProperties: true,
      description:
        "Output shape. Reachable from later steps via {{<step-id>.result.fieldName}}.",
    },
  ),
  errorHandlingOptions: ErrorHandlingOptionsSchema,
};

// CREATE_RECORD
export const CreateRecordActionSettingsSchema = Type.Object({
  input: Type.Object({
    objectName: Type.String({
      description: "Lowercase object name, e.g. 'person', 'company', 'task'.",
    }),
    objectRecord: Type.Object({}, { additionalProperties: true }),
  }),
  ...BaseActionSettingsExtension,
});

// UPDATE_RECORD
export const UpdateRecordActionSettingsSchema = Type.Object({
  input: Type.Object({
    objectName: Type.String(),
    objectRecord: Type.Object({}, { additionalProperties: true }),
    objectRecordId: Type.String({
      description:
        "UUID of the record to update. Often '{{trigger.object.id}}' or '{{step-x.result.id}}'.",
    }),
    fieldsToUpdate: Type.Array(Type.String(), {
      description: "Names of the fields to PATCH (others stay untouched).",
    }),
  }),
  ...BaseActionSettingsExtension,
});

// UPSERT_RECORD
export const UpsertRecordActionSettingsSchema = Type.Object({
  input: Type.Object({
    objectName: Type.String(),
    objectRecord: Type.Object({}, { additionalProperties: true }),
  }),
  ...BaseActionSettingsExtension,
});

// DELETE_RECORD
export const DeleteRecordActionSettingsSchema = Type.Object({
  input: Type.Object({
    objectName: Type.String(),
    objectRecordId: Type.String(),
  }),
  ...BaseActionSettingsExtension,
});

// FIND_RECORDS
export const FindRecordsActionSettingsSchema = Type.Object({
  input: Type.Object({
    objectName: Type.String(),
    limit: Type.Optional(Type.Integer()),
    filter: Type.Optional(
      Type.Object(
        {
          recordFilterGroups: Type.Optional(Type.Array(Type.Any())),
          recordFilters: Type.Optional(Type.Array(Type.Any())),
          gqlOperationFilter: Type.Optional(Type.Any()),
        },
        { additionalProperties: true },
      ),
    ),
    orderBy: Type.Optional(
      Type.Object(
        {
          recordSorts: Type.Optional(Type.Array(Type.Any())),
          gqlOperationOrderBy: Type.Optional(Type.Array(Type.Any())),
        },
        { additionalProperties: true },
      ),
    ),
  }),
  ...BaseActionSettingsExtension,
});

// SEND_EMAIL / DRAFT_EMAIL share the same shape
export const WorkflowFileSchema = Type.Object(
  {
    fileName: Type.Optional(Type.String()),
    fileToken: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export const SendEmailActionSettingsSchema = Type.Object({
  input: Type.Object({
    connectedAccountId: Type.String({
      description:
        "UUID of a Twenty `connectedAccount` (Gmail/M365 OAuth-linked account).",
    }),
    recipients: Type.Object({
      to: Type.Optional(Type.String()),
      cc: Type.Optional(Type.String()),
      bcc: Type.Optional(Type.String()),
    }),
    subject: Type.Optional(Type.String()),
    body: Type.Optional(Type.String()),
    files: Type.Optional(Type.Array(WorkflowFileSchema)),
    inReplyTo: Type.Optional(Type.String()),
  }),
  ...BaseActionSettingsExtension,
});

// HTTP_REQUEST
export const HttpRequestActionSettingsSchema = Type.Object({
  input: Type.Object({
    url: Type.String(),
    method: Type.Union([
      Type.Literal("GET"),
      Type.Literal("POST"),
      Type.Literal("PUT"),
      Type.Literal("PATCH"),
      Type.Literal("DELETE"),
    ]),
    headers: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description:
          "HTTP headers as a string→string map (e.g. {'Content-Type': 'application/json'}).",
      }),
    ),
    body: Type.Optional(
      Type.Union([
        Type.Object({}, { additionalProperties: true }),
        Type.String(),
      ]),
    ),
  }),
  ...BaseActionSettingsExtension,
});

// AI_AGENT
export const AiAgentActionSettingsSchema = Type.Object({
  input: Type.Object({
    agentId: Type.Optional(
      Type.String({
        description:
          "UUID of a pre-configured AI agent in Twenty. Either agentId OR prompt.",
      }),
    ),
    prompt: Type.Optional(
      Type.String({
        description:
          "Free-form prompt. Supports {{trigger.x}} and {{step-x.result.y}} variable refs.",
      }),
    ),
  }),
  ...BaseActionSettingsExtension,
});

// FILTER (predicate, no branching — passes/fails the chain)
export const FilterActionSettingsSchema = Type.Object({
  input: Type.Object({
    stepFilterGroups: Type.Array(StepFilterGroupSchema),
    stepFilters: Type.Array(StepFilterSchema),
  }),
  ...BaseActionSettingsExtension,
});

// IF_ELSE (branching — N branches with their own filter groups)
export const StepIfElseBranchSchema = Type.Object({
  id: Type.String(),
  nextStepIds: Type.Array(Type.String()),
  filterGroupId: Type.Optional(Type.String()),
});

export const IfElseActionSettingsSchema = Type.Object({
  input: Type.Object({
    stepFilterGroups: Type.Array(StepFilterGroupSchema),
    stepFilters: Type.Array(StepFilterSchema),
    branches: Type.Array(StepIfElseBranchSchema),
  }),
  ...BaseActionSettingsExtension,
});

// ITERATOR (loop over a list)
export const IteratorActionSettingsSchema = Type.Object({
  input: Type.Object({
    items: Type.Optional(
      Type.Union([
        Type.Array(Type.Any()),
        Type.String({
          description:
            "Variable ref to a list, e.g. '{{step-find.result.records}}'.",
        }),
      ]),
    ),
    initialLoopStepIds: Type.Optional(
      Type.Array(Type.String(), {
        description: "Step IDs that form the loop body (executed per item).",
      }),
    ),
    shouldContinueOnIterationFailure: Type.Optional(Type.Boolean()),
  }),
  ...BaseActionSettingsExtension,
});

// DELAY (scheduled date or duration)
export const DelayActionSettingsSchema = Type.Object({
  input: Type.Object({
    delayType: Type.Union([
      Type.Literal("SCHEDULED_DATE"),
      Type.Literal("DURATION"),
    ]),
    scheduledDateTime: Type.Optional(
      Type.Union([Type.String(), Type.Null()]),
    ),
    duration: Type.Optional(
      Type.Object({
        days: Type.Optional(Type.Union([Type.Number(), Type.String()])),
        hours: Type.Optional(Type.Union([Type.Number(), Type.String()])),
        minutes: Type.Optional(Type.Union([Type.Number(), Type.String()])),
        seconds: Type.Optional(Type.Union([Type.Number(), Type.String()])),
      }),
    ),
  }),
  ...BaseActionSettingsExtension,
});

// FORM (dynamic form for FORM steps — array of field definitions)
export const FormFieldSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  label: Type.String(),
  type: Type.Union([
    Type.Literal("TEXT"),
    Type.Literal("NUMBER"),
    Type.Literal("DATE"),
    Type.Literal("SELECT"),
    Type.Literal("MULTI_SELECT"),
    Type.Literal("RECORD"),
  ]),
  placeholder: Type.Optional(Type.String()),
  settings: Type.Optional(Type.Object({}, { additionalProperties: true })),
  value: Type.Optional(Type.Any()),
});

export const FormActionSettingsSchema = Type.Object({
  input: Type.Array(FormFieldSchema),
  ...BaseActionSettingsExtension,
});

// CODE / LOGIC_FUNCTION (code step — links to a logicFunction)
export const CodeActionSettingsSchema = Type.Object({
  input: Type.Object({
    logicFunctionId: Type.String({
      description:
        "Auto-created when the CODE step is added via twenty_workflow_step_add. " +
        "DO NOT set this manually unless re-linking an existing function.",
    }),
    logicFunctionInput: Type.Object(
      {},
      {
        additionalProperties: true,
        description:
          "Key/value map of arguments passed to the logic function at runtime.",
      },
    ),
  }),
  ...BaseActionSettingsExtension,
});

export const LogicFunctionActionSettingsSchema = CodeActionSettingsSchema;

// EMPTY (placeholder step, no input)
export const EmptyActionSettingsSchema = Type.Object({
  input: Type.Object({}),
  ...BaseActionSettingsExtension,
});

// ---------------------------------------------------------------------------
// Final composite — a workflow step. The action union has 17 branches but
// for ergonomics we expose a single Type.Object with discriminated `type`
// + `settings: Type.Any()` because each settings shape is type-specific
// (above). The tool description embeds the per-type schema decision tree.
// ---------------------------------------------------------------------------

export const WorkflowStepSchema = Type.Object({
  id: Type.String({
    description:
      "Unique step id (UUID). Use as source/target in edges, and for " +
      "variable refs `{{<id>.result.fieldName}}` from later steps.",
  }),
  name: Type.String({
    description: "Human-readable step name (shown in the workflow builder UI).",
  }),
  type: WorkflowActionTypeSchema,
  valid: Type.Boolean({
    description:
      "Set to true when settings are fully configured. Twenty rejects " +
      "activation if any step has valid:false.",
  }),
  settings: Type.Any({
    description:
      "Settings object — shape depends on `type`. See twenty_workflow_step_add " +
      "tool description for the per-type required fields.",
  }),
  position: Type.Optional(Type.Union([PositionSchema, Type.Null()])),
  nextStepIds: Type.Optional(
    Type.Union([Type.Array(Type.String()), Type.Null()]),
  ),
});

// Edge between two steps in the workflow graph.
export const WorkflowEdgeSchema = Type.Object({
  source: Type.String({
    description:
      'Source step id. Use the literal "trigger" for the workflow trigger.',
  }),
  target: Type.String({ description: "Target step id." }),
});

// Step position in the visual builder (for update_workflow_version_positions).
export const WorkflowStepPositionSchema = Type.Object({
  stepId: Type.String({
    description: 'Step id, or "trigger" for the trigger step.',
  }),
  position: PositionSchema,
});

// ---------------------------------------------------------------------------
// Helper — variable reference patterns the LLM should know.
// ---------------------------------------------------------------------------
export const VARIABLE_REF_HELP = `
Variable references inside any string field:
  {{trigger.fieldName}}             — for DATABASE_EVENT/MANUAL triggers, the
                                      record/object that fired the workflow.
  {{trigger.body.fieldName}}        — for WEBHOOK POST triggers, the body.
  {{<step-id>.result.fieldName}}    — output of an earlier step. step-id is
                                      the step's UUID, NOT its name. Discover
                                      step ids via twenty_workflow_get.
`;

// ---------------------------------------------------------------------------
// Type aliases for callers.
// ---------------------------------------------------------------------------
export type WorkflowTrigger = Static<typeof WorkflowTriggerSchema>;
export type WorkflowStep = Static<typeof WorkflowStepSchema>;
export type WorkflowEdge = Static<typeof WorkflowEdgeSchema>;
