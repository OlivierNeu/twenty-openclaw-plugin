// Twenty workspace metadata tools.
//
// `twenty_workspace_info` is read-only: it lists all metadata objects
// (standard + custom) exposed by the configured Twenty workspace. The
// returned summary is the recommended bootstrap call when the agent is
// asked to "explore" a workspace it has never seen before.
//
// Verified against the Twenty REST metadata reference:
//   - GET /rest/metadata/objects → returns all object types with their
//     fields. Response wrapping has shifted across versions; the tool
//     parses `resp.data?.objects ?? resp.objects ?? []` defensively.

import { Type } from "@sinclair/typebox";

import { defineTwentyTool } from "./_factory.js";
import type { TwentyClient } from "../twenty-client.js";
import type { TwentyMetadataObject } from "../types.js";

interface MetadataObjectsResponse {
  data?: { objects?: TwentyMetadataObject[] };
  objects?: TwentyMetadataObject[];
}

export function buildWorkspaceTools(client: TwentyClient) {
  return [
    defineTwentyTool(
      {
        name: "twenty_workspace_info",
        description:
          "Returns Twenty workspace info: server URL, list of object types " +
          "(standard + custom), and aggregate counts. Read-only — use this " +
          "as the first call when exploring an unfamiliar workspace before " +
          "querying records.",
        // No parameters: the API key itself is workspace-scoped, and the
        // serverUrl is read from plugin config.
        parameters: Type.Object({}),
        run: async (_params, c) => {
          const resp = await c.request<MetadataObjectsResponse>(
            "GET",
            "/rest/metadata/objects",
          );

          const objects: TwentyMetadataObject[] =
            resp?.data?.objects ?? resp?.objects ?? [];

          const customObjectCount = objects.filter(
            (o) => o.isCustom === true,
          ).length;

          return {
            workspaceUrl: c.serverUrl,
            objectCount: objects.length,
            customObjectCount,
            objects: objects.map((o) => ({
              nameSingular: o.nameSingular,
              namePlural: o.namePlural,
              labelSingular: o.labelSingular,
              labelPlural: o.labelPlural,
              isCustom: o.isCustom ?? false,
              isActive: o.isActive ?? true,
              isSystem: o.isSystem ?? false,
              fieldCount: Array.isArray(o.fields) ? o.fields.length : 0,
            })),
          };
        },
      },
      client,
    ),

    // ----- v0.8.0 PR6 — Surface 6 Workspace settings (3 tools) -----

    defineTwentyTool(
      {
        name: "twenty_workspace_get",
        description:
          "Returns the current workspace's settings: subdomain, " +
          "displayName, logo, auth providers (Google / Microsoft / " +
          "Password / 2FA), retention windows (trash / event log), " +
          "default role id, and AI model settings (fastModel, " +
          "smartModel, aiAdditionalInstructions, enabledAiModelIds, " +
          "useRecommendedModels). Distinct from twenty_workspace_info " +
          "which lists the metadata objects.",
        parameters: Type.Object({}),
        run: async (_params, c, signal) => {
          const data = await c.postGraphQL<{
            currentWorkspace: Record<string, unknown>;
          }>(
            `query CurrentWs {
              currentWorkspace {
                id displayName logo subdomain customDomain
                allowImpersonation isPublicInviteLinkEnabled
                isGoogleAuthEnabled isGoogleAuthBypassEnabled
                isPasswordAuthEnabled isPasswordAuthBypassEnabled
                isMicrosoftAuthEnabled
                isTwoFactorAuthenticationEnforced
                trashRetentionDays eventLogRetentionDays
                workspaceMembersCount activationStatus metadataVersion
                databaseSchema
              }
            }`,
            {},
            { signal },
          );
          return data.currentWorkspace;
        },
      },
      client,
    ),

    // NOTE — `updateWorkspace` was scoped out of v0.8.0 after live
    // testing on Twenty 2.1 returned `FORBIDDEN — This endpoint requires
    // a user context. API keys are not supported.` The workspace
    // settings are reachable from the UI; in a future Twenty release
    // (or when Twenty exposes a user-impersonation flow for API keys)
    // the tool can be reintroduced.

    defineTwentyTool(
      {
        name: "twenty_workspace_run_migration",
        description:
          "Apply a workspace migration atomically (Twenty's " +
          "`runWorkspaceMigration` mutation). Migrations are arbitrarily " +
          "powerful — they can create, modify, drop objects/fields/" +
          "indexes in one transaction. The agent must supply the full " +
          "list of `actions` matching Twenty's WorkspaceMigrationAction " +
          "schema. **Approval-gated CRITICAL** — irreversible at the " +
          "schema level.",
        mutates: true,
        parameters: Type.Object({
          actions: Type.Array(
            Type.Any({
              description:
                "Migration action — one of the WorkspaceMigrationAction" +
                "Type variants (CREATE_OBJECT / ALTER_OBJECT / " +
                "DELETE_OBJECT / CREATE_FIELD / ALTER_FIELD / " +
                "DELETE_FIELD / CREATE_INDEX / DELETE_INDEX, ...). The " +
                "plugin forwards the JSON verbatim — Twenty validates " +
                "the discriminator and the per-action payload.",
            }),
            { minItems: 1 },
          ),
        }),
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{ runWorkspaceMigration: boolean }>(
            `mutation RunMigration($input: WorkspaceMigrationInput!) {
              runWorkspaceMigration(workspaceMigration: $input)
            }`,
            { input: { actions: params.actions } },
            { signal },
          );
          return {
            applied: data.runWorkspaceMigration === true,
            actionCount: params.actions.length,
          };
        },
      },
      client,
    ),
  ];
}
