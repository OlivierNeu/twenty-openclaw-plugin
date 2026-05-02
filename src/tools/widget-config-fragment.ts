// GraphQL inline-fragment selection for the `WidgetConfiguration` union.
//
// Twenty's PageLayoutWidget exposes `configuration` as a UNION of 24
// concrete types (AggregateChartConfiguration, BarChartConfiguration,
// PieChartConfiguration, ...). GraphQL requires inline fragments to
// query union members, so this constant lists every member with the
// full set of fields the agent might need.
//
// Inlined verbatim into queries that fetch widgets:
//   `configuration { ${WIDGET_CONFIGURATION_FRAGMENT} }`
//
// Discovered via `__type(name: "WidgetConfiguration")` introspection
// against Twenty 2.1. If Twenty adds new chart types, append them
// here — missing types degrade gracefully (the union member is
// returned but with no fields beyond `__typename`).

export const WIDGET_CONFIGURATION_FRAGMENT = `
  __typename
  ... on AggregateChartConfiguration {
    configurationType aggregateFieldMetadataId aggregateOperation
    label displayDataLabel format description filter timezone
    firstDayOfTheWeek prefix suffix
    ratioAggregateConfig { fieldMetadataId optionValue }
  }
  ... on BarChartConfiguration {
    configurationType aggregateFieldMetadataId aggregateOperation
    primaryAxisGroupByFieldMetadataId primaryAxisGroupBySubFieldName
    primaryAxisDateGranularity primaryAxisOrderBy primaryAxisManualSortOrder
    secondaryAxisGroupByFieldMetadataId secondaryAxisGroupBySubFieldName
    secondaryAxisGroupByDateGranularity secondaryAxisOrderBy
    secondaryAxisManualSortOrder omitNullValues splitMultiValueFields
    axisNameDisplay displayDataLabel displayLegend rangeMin rangeMax
    description color filter groupMode layout isCumulative timezone
    firstDayOfTheWeek
  }
  ... on LineChartConfiguration {
    configurationType aggregateFieldMetadataId aggregateOperation
    primaryAxisGroupByFieldMetadataId primaryAxisGroupBySubFieldName
    primaryAxisDateGranularity primaryAxisOrderBy primaryAxisManualSortOrder
    secondaryAxisGroupByFieldMetadataId secondaryAxisGroupBySubFieldName
    secondaryAxisGroupByDateGranularity secondaryAxisOrderBy
    secondaryAxisManualSortOrder omitNullValues splitMultiValueFields
    axisNameDisplay displayDataLabel displayLegend rangeMin rangeMax
    description color filter isStacked isCumulative timezone
    firstDayOfTheWeek
  }
  ... on PieChartConfiguration {
    configurationType aggregateFieldMetadataId aggregateOperation
    groupByFieldMetadataId groupBySubFieldName dateGranularity orderBy
    manualSortOrder displayDataLabel showCenterMetric displayLegend
    hideEmptyCategory splitMultiValueFields description color filter
    timezone firstDayOfTheWeek
  }
  ... on GaugeChartConfiguration {
    configurationType aggregateFieldMetadataId aggregateOperation
    displayDataLabel color description filter timezone firstDayOfTheWeek
  }
  ... on RecordTableConfiguration { configurationType viewId }
  ... on IframeConfiguration { configurationType url }
  ... on StandaloneRichTextConfiguration {
    configurationType
    body { blocknote markdown }
  }
  ... on ViewConfiguration { configurationType }
  ... on FieldConfiguration {
    configurationType fieldMetadataId fieldDisplayMode
  }
  ... on FieldsConfiguration {
    configurationType viewId newFieldDefaultVisibility
    shouldAllowUserToSeeHiddenFields
  }
  ... on FieldRichTextConfiguration { configurationType }
  ... on TimelineConfiguration { configurationType }
  ... on TasksConfiguration { configurationType }
  ... on NotesConfiguration { configurationType }
  ... on FilesConfiguration { configurationType }
  ... on EmailsConfiguration { configurationType }
  ... on EmailThreadConfiguration { configurationType }
  ... on CalendarConfiguration { configurationType }
  ... on WorkflowConfiguration { configurationType }
  ... on WorkflowVersionConfiguration { configurationType }
  ... on WorkflowRunConfiguration { configurationType }
  ... on FrontComponentConfiguration { configurationType frontComponentId }
`;
