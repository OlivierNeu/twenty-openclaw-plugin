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
  ];
}
