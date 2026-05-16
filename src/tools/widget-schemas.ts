// TypeBox schemas for Twenty PageLayoutWidget configuration.
//
// Direct port of `packages/twenty-server/src/modules/dashboard/tools/
// schemas/widget.schema.ts` from the Twenty source tree (Zod → TypeBox).
// Mirrors the canonical contract Twenty's own LLM agent uses, so the
// OpenClaw agent gets the same expressive surface.
//
// Twenty validates server-side regardless — these schemas are primarily
// for the LLM's benefit (so it discovers what's possible without trial
// and error). We keep them loose where TypeBox's discriminator would be
// awkward and let Twenty surface validation errors via TwentyApiError.

import { Type, type Static } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Enum-as-string-union types — TypeBox lacks a first-class enum primitive.
// Sourced from twenty-shared (AggregateOperations) and from
// metadata-modules/page-layout-widget/enums/* in the Twenty source.
// ---------------------------------------------------------------------------

// PageLayoutType — only DASHBOARD is meaningful for this plugin's tools.
// RECORD_PAGE / RECORD_INDEX / STANDALONE_PAGE are layouts attached to
// objects (record details, table headers, ...) which the agent should
// not be modelling through dashboard tools.
export const PageLayoutTypeSchema = Type.Union(
  [
    Type.Literal("DASHBOARD"),
    Type.Literal("RECORD_PAGE"),
    Type.Literal("RECORD_INDEX"),
    Type.Literal("STANDALONE_PAGE"),
  ],
  {
    description:
      "Page layout type. Use DASHBOARD for dashboards (default in tools). " +
      "RECORD_PAGE/RECORD_INDEX/STANDALONE_PAGE are for record pages and " +
      "should not be created via dashboard tools.",
  },
);

// 12 aggregation operations (twenty-shared/AggregateOperations.ts).
export const AggregateOperationSchema = Type.Union(
  [
    Type.Literal("MIN"),
    Type.Literal("MAX"),
    Type.Literal("AVG"),
    Type.Literal("SUM"),
    Type.Literal("COUNT"),
    Type.Literal("COUNT_UNIQUE_VALUES"),
    Type.Literal("COUNT_EMPTY"),
    Type.Literal("COUNT_NOT_EMPTY"),
    Type.Literal("COUNT_TRUE"),
    Type.Literal("COUNT_FALSE"),
    Type.Literal("PERCENTAGE_EMPTY"),
    Type.Literal("PERCENTAGE_NOT_EMPTY"),
  ],
  {
    description:
      "Aggregation operation: MIN/MAX/AVG/SUM/COUNT (numeric), " +
      "COUNT_UNIQUE_VALUES, COUNT_EMPTY/NOT_EMPTY, COUNT_TRUE/FALSE " +
      "(booleans), PERCENTAGE_EMPTY/NOT_EMPTY.",
  },
);

// Widget types — full enum (19 values) sourced from Twenty 2.1's
// `__type(name: "WidgetType")` introspection. The original v0.7.x
// plugin only exposed 5 LLM-friendly types (GRAPH / RECORD_TABLE /
// IFRAME / STANDALONE_RICH_TEXT / VIEW), but Twenty 2.1 supports
// 14 additional native widgets (FIELDS / FIELD / FIELD_RICH_TEXT /
// TIMELINE / TASKS / NOTES / FILES / EMAILS / CALENDAR / WORKFLOW /
// WORKFLOW_VERSION / WORKFLOW_RUN / FRONT_COMPONENT / EMAIL_THREAD).
// Adding them lets the agent inspect AND create native widgets that
// Twenty auto-creates on RECORD_PAGE layouts (e.g. Note's bodyV2
// widget = FIELD_RICH_TEXT). v0.8.2 added the missing 14.
export const WidgetTypeSchema = Type.Union(
  [
    // Pre-v0.8.2 (LLM-friendly chart/embed/table set)
    Type.Literal("GRAPH"),
    Type.Literal("RECORD_TABLE"),
    Type.Literal("IFRAME"),
    Type.Literal("STANDALONE_RICH_TEXT"),
    Type.Literal("VIEW"),
    // Added in v0.8.2 — native record-page widgets
    Type.Literal("FIELDS"),
    Type.Literal("FIELD"),
    Type.Literal("FIELD_RICH_TEXT"),
    Type.Literal("TIMELINE"),
    Type.Literal("TASKS"),
    Type.Literal("NOTES"),
    Type.Literal("FILES"),
    Type.Literal("EMAILS"),
    Type.Literal("CALENDAR"),
    Type.Literal("WORKFLOW"),
    Type.Literal("WORKFLOW_VERSION"),
    Type.Literal("WORKFLOW_RUN"),
    Type.Literal("FRONT_COMPONENT"),
    Type.Literal("EMAIL_THREAD"),
  ],
  {
    description:
      "Widget type. Charts/embeds: GRAPH (KPI/bar/line/pie), " +
      "RECORD_TABLE (table view), IFRAME (embedded URL), " +
      "STANDALONE_RICH_TEXT (markdown notes), VIEW (existing Twenty view). " +
      "Native RECORD_PAGE widgets: FIELDS (the multi-field section bound " +
      "to a FIELDS_WIDGET view, see RECORD_PAGE pattern), FIELD (single " +
      "field), FIELD_RICH_TEXT (RICH_TEXT field with multi-line rendering, " +
      "matches Twenty's bodyV2 pattern on Note/Task), TIMELINE/TASKS/NOTES/" +
      "FILES/EMAILS/CALENDAR (auto-rendered relation tabs), WORKFLOW / " +
      "WORKFLOW_VERSION / WORKFLOW_RUN (workflow surfaces), FRONT_COMPONENT " +
      "(workspace custom UI module), EMAIL_THREAD (single thread render).",
  },
);

// Graph configuration discriminator — what kind of chart is this widget.
// GAUGE_CHART is intentionally absent: Twenty 2.3 removed gauge support
// and ships a destructive migration (`delete-gauge-widgets`) that wipes
// existing gauge widgets. Creating one via the plugin would be rejected
// or silently deleted on the next upgrade. The `GaugeChartConfigSchema`
// + GraphQL fragment are kept READ-ONLY for back-compat (the union type
// still exists in Twenty's GraphQL schema for legacy reads).
export const ConfigurationTypeSchema = Type.Union([
  Type.Literal("AGGREGATE_CHART"),
  Type.Literal("PIE_CHART"),
  Type.Literal("BAR_CHART"),
  Type.Literal("LINE_CHART"),
  Type.Literal("RECORD_TABLE"),
  Type.Literal("IFRAME"),
  Type.Literal("STANDALONE_RICH_TEXT"),
  Type.Literal("VIEW"),
]);

export const BarChartLayoutSchema = Type.Union([
  Type.Literal("VERTICAL"),
  Type.Literal("HORIZONTAL"),
]);

export const BarChartGroupModeSchema = Type.Union([
  Type.Literal("STACKED"),
  Type.Literal("GROUPED"),
]);

export const GraphOrderBySchema = Type.Union([
  Type.Literal("FIELD_ASC"),
  Type.Literal("FIELD_DESC"),
  Type.Literal("FIELD_POSITION_ASC"),
  Type.Literal("FIELD_POSITION_DESC"),
  Type.Literal("VALUE_ASC"),
  Type.Literal("VALUE_DESC"),
  Type.Literal("MANUAL"),
]);

export const AxisNameDisplaySchema = Type.Union([
  Type.Literal("NONE"),
  Type.Literal("X"),
  Type.Literal("Y"),
  Type.Literal("BOTH"),
]);

export const DateGranularitySchema = Type.Union(
  [
    Type.Literal("DAY"),
    Type.Literal("WEEK"),
    Type.Literal("MONTH"),
    Type.Literal("QUARTER"),
    Type.Literal("YEAR"),
    Type.Literal("DAY_OF_THE_WEEK"),
    Type.Literal("MONTH_OF_THE_YEAR"),
    Type.Literal("QUARTER_OF_THE_YEAR"),
  ],
  {
    description:
      "Date grouping granularity. DAY/WEEK/MONTH/QUARTER/YEAR are " +
      "calendar-anchored. DAY_OF_THE_WEEK / MONTH_OF_THE_YEAR / " +
      "QUARTER_OF_THE_YEAR collapse across years (useful for seasonality).",
  },
);

// 26 chart colors (auto + 25 named) per twenty-ui's MAIN_COLOR_NAMES.
export const ChartColorSchema = Type.Union([
  Type.Literal("auto"),
  Type.Literal("red"),
  Type.Literal("ruby"),
  Type.Literal("crimson"),
  Type.Literal("tomato"),
  Type.Literal("orange"),
  Type.Literal("amber"),
  Type.Literal("yellow"),
  Type.Literal("lime"),
  Type.Literal("grass"),
  Type.Literal("green"),
  Type.Literal("jade"),
  Type.Literal("mint"),
  Type.Literal("turquoise"),
  Type.Literal("cyan"),
  Type.Literal("sky"),
  Type.Literal("blue"),
  Type.Literal("iris"),
  Type.Literal("violet"),
  Type.Literal("purple"),
  Type.Literal("plum"),
  Type.Literal("pink"),
  Type.Literal("bronze"),
  Type.Literal("gold"),
  Type.Literal("brown"),
  Type.Literal("gray"),
]);

// ---------------------------------------------------------------------------
// Grid position — every widget lives on a 12-column grid. Row spans for
// charts are typically 6-8, KPIs 2-4. Twenty doesn't enforce a maximum
// row index (the dashboard scrolls).
// ---------------------------------------------------------------------------
export const GridPositionSchema = Type.Object(
  {
    row: Type.Integer({ minimum: 0, description: "Row position (0-based)" }),
    column: Type.Integer({
      minimum: 0,
      maximum: 11,
      description: "Column position (0-11, 12-column grid)",
    }),
    rowSpan: Type.Integer({
      minimum: 1,
      description:
        "Number of rows the widget spans. Typical sizes: KPI 2-4, charts 6-8.",
    }),
    columnSpan: Type.Integer({
      minimum: 1,
      maximum: 12,
      description:
        "Number of columns (1-12). Full width=12, half=6, third=4, quarter=3.",
    }),
  },
  { description: "Position and size of a widget on the 12-column dashboard grid." },
);

// ---------------------------------------------------------------------------
// Per-chart configuration objects.
//
// We don't use TypeBox's `Type.Union` discriminator here because TypeBox
// generates a less ergonomic schema for the LLM than a flat optional
// object. Twenty's GraphQL endpoint validates the right shape based on
// `configurationType`, so we let the agent build the object freely and
// surface server-side errors through TwentyApiError.
// ---------------------------------------------------------------------------

const RatioAggregateConfigSchema = Type.Object({
  fieldMetadataId: Type.String({ description: "Boolean field UUID" }),
  optionValue: Type.String({
    description: "Value to compute the ratio against (e.g. 'true').",
  }),
});

// AGGREGATE_CHART (KPI number) — single big metric.
export const AggregateChartConfigSchema = Type.Object({
  configurationType: Type.Literal("AGGREGATE_CHART"),
  aggregateFieldMetadataId: Type.String({
    description:
      "Field UUID to aggregate. Must belong to the widget's objectMetadataId.",
  }),
  aggregateOperation: AggregateOperationSchema,
  label: Type.Optional(Type.String({ description: "Display label" })),
  prefix: Type.Optional(Type.String({ description: "e.g. '$' or '€'" })),
  suffix: Type.Optional(Type.String({ description: "e.g. '%' or 'leads'" })),
  displayDataLabel: Type.Optional(Type.Boolean()),
  ratioAggregateConfig: Type.Optional(RatioAggregateConfigSchema),
});

// BAR_CHART — primary axis groupBy + optional secondary grouping.
export const BarChartConfigSchema = Type.Object({
  configurationType: Type.Literal("BAR_CHART"),
  aggregateFieldMetadataId: Type.String({ description: "Field UUID to aggregate" }),
  aggregateOperation: AggregateOperationSchema,
  primaryAxisGroupByFieldMetadataId: Type.String({
    description: "Field UUID to group by on the primary (X) axis",
  }),
  primaryAxisGroupBySubFieldName: Type.Optional(
    Type.String({
      description:
        'REQUIRED for relation fields (e.g. "name") and composite fields ' +
        '(e.g. "addressCity"). Without this, relation fields group by raw ' +
        "UUID, which is useless. For dates use primaryAxisDateGranularity instead.",
    }),
  ),
  secondaryAxisGroupByFieldMetadataId: Type.Optional(Type.String()),
  secondaryAxisGroupBySubFieldName: Type.Optional(Type.String()),
  primaryAxisOrderBy: Type.Optional(GraphOrderBySchema),
  primaryAxisManualSortOrder: Type.Optional(Type.Array(Type.String())),
  secondaryAxisOrderBy: Type.Optional(GraphOrderBySchema),
  secondaryAxisManualSortOrder: Type.Optional(Type.Array(Type.String())),
  primaryAxisDateGranularity: Type.Optional(DateGranularitySchema),
  secondaryAxisGroupByDateGranularity: Type.Optional(DateGranularitySchema),
  omitNullValues: Type.Optional(Type.Boolean()),
  color: Type.Optional(ChartColorSchema),
  axisNameDisplay: Type.Optional(AxisNameDisplaySchema),
  displayDataLabel: Type.Optional(Type.Boolean()),
  displayLegend: Type.Optional(Type.Boolean()),
  groupMode: Type.Optional(BarChartGroupModeSchema),
  isCumulative: Type.Optional(Type.Boolean()),
  rangeMin: Type.Optional(Type.Number()),
  rangeMax: Type.Optional(Type.Number()),
  layout: BarChartLayoutSchema,
});

// LINE_CHART — same fields as BAR minus layout/groupMode, plus isStacked.
export const LineChartConfigSchema = Type.Object({
  configurationType: Type.Literal("LINE_CHART"),
  aggregateFieldMetadataId: Type.String(),
  aggregateOperation: AggregateOperationSchema,
  primaryAxisGroupByFieldMetadataId: Type.String(),
  primaryAxisGroupBySubFieldName: Type.Optional(Type.String()),
  secondaryAxisGroupByFieldMetadataId: Type.Optional(Type.String()),
  secondaryAxisGroupBySubFieldName: Type.Optional(Type.String()),
  primaryAxisOrderBy: Type.Optional(GraphOrderBySchema),
  primaryAxisManualSortOrder: Type.Optional(Type.Array(Type.String())),
  secondaryAxisOrderBy: Type.Optional(GraphOrderBySchema),
  secondaryAxisManualSortOrder: Type.Optional(Type.Array(Type.String())),
  primaryAxisDateGranularity: Type.Optional(DateGranularitySchema),
  secondaryAxisGroupByDateGranularity: Type.Optional(DateGranularitySchema),
  omitNullValues: Type.Optional(Type.Boolean()),
  color: Type.Optional(ChartColorSchema),
  axisNameDisplay: Type.Optional(AxisNameDisplaySchema),
  displayDataLabel: Type.Optional(Type.Boolean()),
  displayLegend: Type.Optional(Type.Boolean()),
  isStacked: Type.Optional(Type.Boolean()),
  isCumulative: Type.Optional(Type.Boolean()),
  rangeMin: Type.Optional(Type.Number()),
  rangeMax: Type.Optional(Type.Number()),
});

// PIE_CHART — flat groupBy (note: different field name than BAR/LINE).
export const PieChartConfigSchema = Type.Object({
  configurationType: Type.Literal("PIE_CHART"),
  aggregateFieldMetadataId: Type.String(),
  aggregateOperation: AggregateOperationSchema,
  groupByFieldMetadataId: Type.String({
    description:
      "Field UUID to slice the pie by. Distinct from BAR/LINE which use " +
      "primaryAxisGroupByFieldMetadataId — Twenty's PIE schema is flat.",
  }),
  groupBySubFieldName: Type.Optional(
    Type.String({
      description:
        'REQUIRED for relation fields (e.g. "name") and composite fields ' +
        '(e.g. "addressCity"). Without this, relation fields slice by UUID.',
    }),
  ),
  orderBy: Type.Optional(GraphOrderBySchema),
  manualSortOrder: Type.Optional(Type.Array(Type.String())),
  dateGranularity: Type.Optional(DateGranularitySchema),
  color: Type.Optional(ChartColorSchema),
  displayDataLabel: Type.Optional(Type.Boolean()),
  displayLegend: Type.Optional(Type.Boolean()),
  showCenterMetric: Type.Optional(
    Type.Boolean({ description: "Show aggregate value in pie center" }),
  ),
  hideEmptyCategory: Type.Optional(
    Type.Boolean({ description: "Hide slices with zero values" }),
  ),
});

// GAUGE_CHART — circular gauge, similar shape to AGGREGATE.
// DEPRECATED / READ-ONLY since v0.8.4: Twenty 2.3 removed gauge support
// and runs a destructive `delete-gauge-widgets` migration. This schema is
// retained only so legacy gauge widgets still deserialize on read (the
// GraphQL union member is preserved upstream for back-compat). It is no
// longer offered as a creatable configurationType — see
// ConfigurationTypeSchema. Do NOT add it back to the creation discriminator.
export const GaugeChartConfigSchema = Type.Object({
  configurationType: Type.Literal("GAUGE_CHART"),
  aggregateFieldMetadataId: Type.String(),
  aggregateOperation: AggregateOperationSchema,
  rangeMin: Type.Optional(Type.Number()),
  rangeMax: Type.Optional(Type.Number()),
  color: Type.Optional(ChartColorSchema),
  label: Type.Optional(Type.String()),
  prefix: Type.Optional(Type.String()),
  suffix: Type.Optional(Type.String()),
});

// RECORD_TABLE — table widget bound to an existing Twenty View.
// IMPORTANT: the agent must create a dedicated View (type=TABLE) BEFORE
// creating this widget. Reusing the record-index view is forbidden.
export const RecordTableConfigSchema = Type.Object({
  configurationType: Type.Literal("RECORD_TABLE"),
  viewId: Type.String({
    description:
      "UUID of the Twenty view to render. Must be a dedicated TABLE view " +
      "created with the Views API — never reuse a record-index view " +
      "(future scope: views tools — track in plugin issues).",
  }),
});

// IFRAME — embedded URL.
export const IframeConfigSchema = Type.Object({
  configurationType: Type.Literal("IFRAME"),
  url: Type.Optional(
    Type.String({ format: "uri", description: "URL to embed" }),
  ),
});

// STANDALONE_RICH_TEXT — markdown widget.
export const RichTextConfigSchema = Type.Object({
  configurationType: Type.Literal("STANDALONE_RICH_TEXT"),
  body: Type.Object({
    blocknote: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description: "BlockNote JSON string (advanced).",
      }),
    ),
    markdown: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description:
          "Markdown content (preferred for AI). Headings, bold, lists, links.",
      }),
    ),
  }),
});

// Discriminated union of every shape — what the LLM is allowed to pass
// in `configuration`. We use Type.Any() at the field level (see widget
// tools) and document the union here, because TypeBox's discriminated
// schema is harder for LLMs to author than free-form JSON validated by
// Twenty server-side.
export type WidgetConfiguration =
  | Static<typeof AggregateChartConfigSchema>
  | Static<typeof BarChartConfigSchema>
  | Static<typeof LineChartConfigSchema>
  | Static<typeof PieChartConfigSchema>
  | Static<typeof GaugeChartConfigSchema>
  | Static<typeof RecordTableConfigSchema>
  | Static<typeof IframeConfigSchema>
  | Static<typeof RichTextConfigSchema>;
