// Dashboard tab tools (P7) — `tab_add`, `tab_update`, `tab_delete`.
//
// Tabs live under a PageLayout (Twenty metadata API). Their position is
// 0-based and contiguous; Twenty doesn't reorder automatically when you
// destroy one in the middle, so the agent must call tab_update with new
// positions if it needs to compact after a delete.

import { Type } from "@sinclair/typebox";

import { defineTwentyTool } from "./_factory.js";
import type { TwentyClient } from "../twenty-client.js";

const TabAddSchema = Type.Object({
  pageLayoutId: Type.String({
    description: "PageLayout UUID (from twenty_dashboard_get).",
  }),
  title: Type.String({ description: "Tab title" }),
  position: Type.Optional(
    Type.Integer({
      minimum: 0,
      description:
        "Tab position (0-based). Defaults to the next available slot.",
    }),
  ),
  layoutMode: Type.Optional(
    Type.Union([Type.Literal("GRID"), Type.Literal("FREEFORM")], {
      description: "Layout mode (defaults to GRID).",
    }),
  ),
});

const TabUpdateSchema = Type.Object({
  id: Type.String({ description: "Tab UUID to update" }),
  title: Type.Optional(Type.String()),
  position: Type.Optional(Type.Integer({ minimum: 0 })),
  layoutMode: Type.Optional(
    Type.Union([Type.Literal("GRID"), Type.Literal("FREEFORM")]),
  ),
});

const TabDeleteSchema = Type.Object({
  id: Type.String({ description: "Tab UUID to delete" }),
});

export function buildDashboardTabTools(client: TwentyClient) {
  return [
    defineTwentyTool(
      {
        name: "twenty_dashboard_tab_add",
        description:
          "Add a tab to an existing dashboard. Requires the parent " +
          "pageLayoutId (use twenty_dashboard_get to find it). After " +
          "creation, use twenty_dashboard_widget_add with the returned " +
          "tab id to populate it.",
        mutates: true,
        parameters: TabAddSchema,
        run: async (params, c, signal) => {
          // Auto-compute position when not provided: count current tabs.
          let position = params.position;
          if (position === undefined) {
            const tabsResp = await c.postGraphQL<{
              getPageLayoutTabs: Array<{ position: number }>;
            }>(
              `query Tabs($pageLayoutId: String!) {
                getPageLayoutTabs(pageLayoutId: $pageLayoutId) { position }
              }`,
              { pageLayoutId: params.pageLayoutId },
              { signal },
            );
            position = (tabsResp?.getPageLayoutTabs ?? []).length;
          }

          const data = await c.postGraphQL<{
            createPageLayoutTab: {
              id: string;
              title: string;
              position: number;
              pageLayoutId: string;
            };
          }>(
            `mutation CreateTab($input: CreatePageLayoutTabInput!) {
              createPageLayoutTab(input: $input) {
                id title position pageLayoutId
              }
            }`,
            {
              input: {
                title: params.title,
                pageLayoutId: params.pageLayoutId,
                position,
                layoutMode: params.layoutMode,
              },
            },
            { signal },
          );
          return data.createPageLayoutTab;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_dashboard_tab_update",
        description:
          "Update a tab's title, position, or layoutMode. Only fields " +
          "you supply are modified.",
        mutates: true,
        parameters: TabUpdateSchema,
        run: async (params, c, signal) => {
          const { id, ...updates } = params;
          const data = await c.postGraphQL<{
            updatePageLayoutTab: {
              id: string;
              title: string;
              position: number;
            };
          }>(
            `mutation UpdateTab($id: String!, $input: UpdatePageLayoutTabInput!) {
              updatePageLayoutTab(id: $id, input: $input) {
                id title position
              }
            }`,
            { id, input: updates },
            { signal },
          );
          return data.updatePageLayoutTab;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_dashboard_tab_delete",
        description:
          "HARD-delete a tab and every widget it contains. Irreversible. " +
          "Approval-gated by default. After deleting, position numbers " +
          "of remaining tabs are NOT auto-compacted — call tab_update to " +
          "fix positioning if needed.",
        mutates: true,
        parameters: TabDeleteSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{ destroyPageLayoutTab: boolean }>(
            `mutation DestroyTab($id: String!) { destroyPageLayoutTab(id: $id) }`,
            { id: params.id },
            { signal },
          );
          return { tabId: params.id, destroyed: data.destroyPageLayoutTab === true };
        },
      },
      client,
    ),
  ];
}
