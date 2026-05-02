// Dashboard widget tools (P7) — `widget_add`, `widget_update`,
// `widget_delete`, `widget_data`.
//
// `widget_add` / `widget_update` rely on a loose `Type.Any()` for the
// configuration field — Twenty's schemas are 5-way discriminated unions
// (AGGREGATE / GAUGE / PIE / BAR / LINE / RECORD_TABLE / IFRAME / RICH_TEXT),
// and the tool description embeds the schema decision tree to guide the
// LLM. See `widget-schemas.ts` for the static type-level reference.
//
// `widget_data` is a read-only convenience that resolves a widget's
// configuration to its computed values, using Twenty's chart-data
// resolvers (barChartData / lineChartData / pieChartData). KPI charts
// (AGGREGATE / GAUGE) don't have a dedicated chart-data endpoint —
// Twenty computes them via the standard record aggregation API; for
// those types `widget_data` returns the configuration unchanged with
// a hint pointing to twenty_record_list + aggregateOperation manually.

import { Type } from "@sinclair/typebox";

import { defineTwentyTool } from "./_factory.js";
import { WIDGET_CONFIGURATION_FRAGMENT } from "./widget-config-fragment.js";
import {
  GridPositionSchema,
  WidgetTypeSchema,
} from "./widget-schemas.js";
import type { TwentyClient } from "../twenty-client.js";

const WidgetAddSchema = Type.Object({
  pageLayoutTabId: Type.String({
    description: "Parent tab UUID (from twenty_dashboard_get).",
  }),
  title: Type.String(),
  type: WidgetTypeSchema,
  gridPosition: GridPositionSchema,
  objectMetadataId: Type.Optional(
    Type.String({
      description:
        "REQUIRED for type=GRAPH and type=RECORD_TABLE — UUID of the " +
        "Twenty object to aggregate or display.",
    }),
  ),
  configuration: Type.Any({
    description: "Widget configuration (shape depends on type).",
  }),
});

const WidgetUpdateSchema = Type.Object({
  id: Type.String({ description: "Widget UUID to update" }),
  title: Type.Optional(Type.String()),
  type: Type.Optional(WidgetTypeSchema),
  gridPosition: Type.Optional(GridPositionSchema),
  objectMetadataId: Type.Optional(Type.String()),
  configuration: Type.Optional(Type.Any()),
  conditionalAvailabilityExpression: Type.Optional(Type.String()),
});

const WidgetDeleteSchema = Type.Object({
  id: Type.String({ description: "Widget UUID to delete" }),
});

const WidgetDataSchema = Type.Object({
  widgetId: Type.String({
    description:
      "Widget UUID. Tool fetches the widget config then dispatches to " +
      "the right chart-data resolver (barChartData / lineChartData / " +
      "pieChartData).",
  }),
});

interface WidgetFetched {
  id: string;
  type: string;
  objectMetadataId: string | null;
  configuration: { configurationType?: string } & Record<string, unknown>;
}

export function buildDashboardWidgetTools(client: TwentyClient) {
  return [
    defineTwentyTool(
      {
        name: "twenty_dashboard_widget_add",
        description:
          "Add a widget to a dashboard tab. Use twenty_dashboard_get to " +
          "find the parent pageLayoutTabId.\n\n" +
          "GRID — 12 columns (0-11). KPI: rowSpan 2-4. Charts: rowSpan 6-8. " +
          "Full width: columnSpan 12, half: 6, third: 4.\n\n" +
          "WIDGET TYPE / configurationType decision tree:\n\n" +
          "  GRAPH + AGGREGATE_CHART (single KPI):\n" +
          "    requires objectMetadataId + configuration.{aggregateField" +
          "MetadataId, aggregateOperation}\n\n" +
          "  GRAPH + BAR_CHART:\n" +
          "    + primaryAxisGroupByFieldMetadataId + layout (VERTICAL|HORIZONTAL)\n" +
          "    + If grouping by RELATION/composite field, MUST set " +
          "primaryAxisGroupBySubFieldName ('name' / 'addressCity' / ...) " +
          "or it groups by raw UUID.\n\n" +
          "  GRAPH + LINE_CHART:\n" +
          "    + primaryAxisGroupByFieldMetadataId (typically a date field, " +
          "use primaryAxisDateGranularity = DAY|WEEK|MONTH|...)\n\n" +
          "  GRAPH + PIE_CHART:\n" +
          "    + groupByFieldMetadataId (NOTE: different field name from BAR/LINE)\n\n" +
          "  GRAPH + GAUGE_CHART:\n" +
          "    + aggregateFieldMetadataId + aggregateOperation + rangeMin + rangeMax\n\n" +
          "  RECORD_TABLE: + configuration.viewId (must create a TABLE view first).\n" +
          "  IFRAME: + configuration.url.\n" +
          "  STANDALONE_RICH_TEXT: + configuration.body.markdown.\n\n" +
          "AggregateOperations: COUNT, COUNT_UNIQUE_VALUES, COUNT_EMPTY, " +
          "COUNT_NOT_EMPTY, COUNT_TRUE, COUNT_FALSE, SUM, AVG, MIN, MAX, " +
          "PERCENTAGE_EMPTY, PERCENTAGE_NOT_EMPTY.",
        mutates: true,
        parameters: WidgetAddSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            createPageLayoutWidget: {
              id: string;
              title: string;
              type: string;
              objectMetadataId: string | null;
              gridPosition: {
                row: number;
                column: number;
                rowSpan: number;
                columnSpan: number;
              };
            };
          }>(
            `mutation CreateWidget($input: CreatePageLayoutWidgetInput!) {
              createPageLayoutWidget(input: $input) {
                id title type objectMetadataId
                gridPosition { row column rowSpan columnSpan }
              }
            }`,
            {
              input: {
                pageLayoutTabId: params.pageLayoutTabId,
                title: params.title,
                type: params.type,
                gridPosition: params.gridPosition,
                objectMetadataId: params.objectMetadataId,
                configuration: params.configuration,
              },
            },
            { signal },
          );
          return data.createPageLayoutWidget;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_dashboard_widget_update",
        description:
          "Update a widget's title, type, gridPosition, objectMetadataId, " +
          "configuration, or conditionalAvailabilityExpression. Only " +
          "fields you supply are modified. Use twenty_dashboard_get to " +
          "find the widgetId.",
        mutates: true,
        parameters: WidgetUpdateSchema,
        run: async (params, c, signal) => {
          const { id, ...updates } = params;
          const data = await c.postGraphQL<{
            updatePageLayoutWidget: {
              id: string;
              title: string;
              type: string;
            };
          }>(
            `mutation UpdateWidget($id: String!, $input: UpdatePageLayoutWidgetInput!) {
              updatePageLayoutWidget(id: $id, input: $input) {
                id title type
              }
            }`,
            { id, input: updates },
            { signal },
          );
          return data.updatePageLayoutWidget;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_dashboard_widget_delete",
        description:
          "HARD-delete a widget. Irreversible. Approval-gated by default.",
        mutates: true,
        parameters: WidgetDeleteSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{ destroyPageLayoutWidget: boolean }>(
            `mutation DestroyWidget($id: String!) { destroyPageLayoutWidget(id: $id) }`,
            { id: params.id },
            { signal },
          );
          return {
            widgetId: params.id,
            destroyed: data.destroyPageLayoutWidget === true,
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_dashboard_widget_data",
        description:
          "Compute the data for a chart widget (BAR/LINE/PIE). Twenty " +
          "evaluates the configuration server-side and returns the " +
          "rendered series — useful so the agent can reason on the same " +
          "numbers a human sees on the dashboard. For AGGREGATE_CHART / " +
          "GAUGE_CHART (single KPI), this tool returns a hint pointing to " +
          "the standard record-aggregation API (no dedicated chart-data " +
          "resolver upstream).",
        parameters: WidgetDataSchema,
        run: async (params, c, signal) => {
          // Step 1 — fetch the widget to discover its type and config.
          const widgetResp = await c.postGraphQL<{
            getPageLayoutWidget: WidgetFetched;
          }>(
            `query Widget($id: String!) {
              getPageLayoutWidget(id: $id) {
                id type objectMetadataId
                configuration { ${WIDGET_CONFIGURATION_FRAGMENT} }
              }
            }`,
            { id: params.widgetId },
            { signal },
          );
          const widget = widgetResp?.getPageLayoutWidget;
          if (!widget) {
            throw new Error(`Widget ${params.widgetId} not found`);
          }

          const cfgType = widget.configuration?.configurationType;
          if (!cfgType) {
            return {
              widgetId: widget.id,
              type: widget.type,
              hint: "Widget has no configurationType — cannot dispatch.",
            };
          }

          // Step 2 — dispatch to the right chart-data query. Each
          // chart-data type has its own shape (BarChartData,
          // LineChartData, PieChartData), discovered via __type
          // introspection on `crm.lacneu.com` (Twenty 2.1).
          //
          // Inner element types:
          //   BarChartSeries: { key, label }
          //   LineChartSeries: { id, label, data: [LineChartDataPoint] }
          //   LineChartDataPoint: { x, y }
          //   PieChartDataItem: { id, value }
          //
          // BarChart `data` and `keys` are list-of-scalar (JSON / String)
          // — no sub-selection needed.
          const BAR_FIELDS =
            "data indexBy keys " +
            "series { key label } " +
            "xAxisLabel yAxisLabel showLegend showDataLabels " +
            "layout groupMode hasTooManyGroups formattedToRawLookup";
          const LINE_FIELDS =
            "series { id label data { x y } } " +
            "xAxisLabel yAxisLabel showLegend showDataLabels " +
            "hasTooManyGroups formattedToRawLookup";
          const PIE_FIELDS =
            "data { id value } " +
            "showLegend showDataLabels showCenterMetric " +
            "hasTooManyGroups formattedToRawLookup";

          const dispatchMap: Record<string, { name: string; query: string }> = {
            BAR_CHART: {
              name: "barChartData",
              query: `query BarData($input: BarChartDataInput!) {
                barChartData(input: $input) { ${BAR_FIELDS} }
              }`,
            },
            LINE_CHART: {
              name: "lineChartData",
              query: `query LineData($input: LineChartDataInput!) {
                lineChartData(input: $input) { ${LINE_FIELDS} }
              }`,
            },
            PIE_CHART: {
              name: "pieChartData",
              query: `query PieData($input: PieChartDataInput!) {
                pieChartData(input: $input) { ${PIE_FIELDS} }
              }`,
            },
          };

          const dispatch = dispatchMap[cfgType];
          if (!dispatch) {
            return {
              widgetId: widget.id,
              type: widget.type,
              configurationType: cfgType,
              hint:
                cfgType === "AGGREGATE_CHART" || cfgType === "GAUGE_CHART"
                  ? "Single-KPI charts have no chart-data resolver. Use " +
                    "twenty_record_list with no records (limit:0) to access " +
                    "Twenty's aggregation field, or pull totals via SQL- " +
                    "compatible filters on the entity."
                  : `No chart-data resolver for configurationType=${cfgType}.`,
              configuration: widget.configuration,
            };
          }

          const data = await c.postGraphQL<Record<string, unknown>>(
            dispatch.query,
            {
              input: {
                objectMetadataId: widget.objectMetadataId,
                configuration: widget.configuration,
              },
            },
            { signal },
          );
          return {
            widgetId: widget.id,
            type: widget.type,
            configurationType: cfgType,
            data: data[dispatch.name],
          };
        },
      },
      client,
    ),
  ];
}
