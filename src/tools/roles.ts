// Roles & Permissions tools — Surface 5 of the v0.8.0 plugin extension.
//
// Twenty 2.1 models access control as:
//   - `Role` — a named bundle of permissions, assignable to users,
//     agents, and API keys. Carries 6 global flags (canReadAllObject
//     Records, canUpdateAllObjectRecords, canDestroyAllObjectRecords,
//     canSoftDeleteAllObjectRecords, canUpdateAllSettings, canAccessAll
//     Tools) plus three "is assignable to" toggles.
//   - `PermissionFlag` — fine-grained capability flags (25 enum values:
//     ROLES, DATA_MODEL, SECURITY, WORKFLOWS, VIEWS, LAYOUTS, BILLING,
//     AI_SETTINGS, AI, IMPORT_CSV, EXPORT_CSV, IMPERSONATE, ...).
//   - `ObjectPermission` — per-object capability map (canRead /
//     canUpdate / canSoftDelete / canDestroyObjectRecords).
//   - `FieldPermission` — per-field capability map (canRead /
//     canUpdateFieldValue).
//   - `RowLevelPermissionPredicate` — conditional access rules
//     (operand + value) within a `RowLevelPermissionPredicateGroup`
//     (logical AND / OR composition).
//
// Every write tool here is approval-gated CRITICAL — wrong permissions
// can lock operators out, expose PII, or silently grant write access.

import { Type } from "@sinclair/typebox";

import { defineTwentyTool } from "./_factory.js";
import type { TwentyClient } from "../twenty-client.js";

interface RoleResp {
  id: string;
  label: string;
  description: string | null;
  icon: string | null;
  isEditable: boolean;
  canBeAssignedToUsers: boolean;
  canBeAssignedToAgents: boolean;
  canBeAssignedToApiKeys: boolean;
  canUpdateAllSettings: boolean;
  canAccessAllTools: boolean;
  canReadAllObjectRecords: boolean;
  canUpdateAllObjectRecords: boolean;
  canSoftDeleteAllObjectRecords: boolean;
  canDestroyAllObjectRecords: boolean;
}

const ROLE_FRAGMENT = `
  id label description icon isEditable
  canBeAssignedToUsers canBeAssignedToAgents canBeAssignedToApiKeys
  canUpdateAllSettings canAccessAllTools
  canReadAllObjectRecords canUpdateAllObjectRecords
  canSoftDeleteAllObjectRecords canDestroyAllObjectRecords
`;

// ---------------------------------------------------------------------------
// Enum schemas
// ---------------------------------------------------------------------------

const PermissionFlagTypeSchema = Type.Union(
  [
    Type.Literal("API_KEYS_AND_WEBHOOKS"),
    Type.Literal("WORKSPACE"),
    Type.Literal("WORKSPACE_MEMBERS"),
    Type.Literal("ROLES"),
    Type.Literal("DATA_MODEL"),
    Type.Literal("SECURITY"),
    Type.Literal("WORKFLOWS"),
    Type.Literal("IMPERSONATE"),
    Type.Literal("SSO_BYPASS"),
    Type.Literal("APPLICATIONS"),
    Type.Literal("MARKETPLACE_APPS"),
    Type.Literal("LAYOUTS"),
    Type.Literal("BILLING"),
    Type.Literal("AI_SETTINGS"),
    Type.Literal("AI"),
    Type.Literal("VIEWS"),
    Type.Literal("UPLOAD_FILE"),
    Type.Literal("DOWNLOAD_FILE"),
    Type.Literal("SEND_EMAIL_TOOL"),
    Type.Literal("HTTP_REQUEST_TOOL"),
    Type.Literal("CODE_INTERPRETER_TOOL"),
    Type.Literal("IMPORT_CSV"),
    Type.Literal("EXPORT_CSV"),
    Type.Literal("CONNECTED_ACCOUNTS"),
    Type.Literal("PROFILE_INFORMATION"),
  ],
  {
    description:
      "Twenty 2.1 PermissionFlag — granular capability key. Whitelist " +
      "is exact: any other value is rejected by the plugin (and would " +
      "be rejected by Twenty too).",
  },
);

const RowLevelPredicateOperandSchema = Type.Union(
  [
    Type.Literal("IS"),
    Type.Literal("IS_NOT_NULL"),
    Type.Literal("IS_NOT"),
    Type.Literal("LESS_THAN_OR_EQUAL"),
    Type.Literal("GREATER_THAN_OR_EQUAL"),
    Type.Literal("IS_BEFORE"),
    Type.Literal("IS_AFTER"),
    Type.Literal("CONTAINS"),
    Type.Literal("DOES_NOT_CONTAIN"),
    Type.Literal("IS_EMPTY"),
    Type.Literal("IS_NOT_EMPTY"),
    Type.Literal("IS_RELATIVE"),
    Type.Literal("IS_IN_PAST"),
    Type.Literal("IS_IN_FUTURE"),
    Type.Literal("IS_TODAY"),
    Type.Literal("VECTOR_SEARCH"),
  ],
  { description: "Row-level predicate operand." },
);

const PredicateGroupLogicalOperatorSchema = Type.Union(
  [Type.Literal("AND"), Type.Literal("OR")],
  { description: "Boolean composition of sibling predicates." },
);

// ---------------------------------------------------------------------------
// Schemas — Role
// ---------------------------------------------------------------------------

const RoleIdParam = Type.Object({
  roleId: Type.String({ description: "Role UUID" }),
});

const CreateRoleSchema = Type.Object({
  label: Type.String({ description: "Role label (visible in the UI)" }),
  description: Type.Optional(Type.String()),
  icon: Type.Optional(Type.String({ description: "Tabler icon name" })),
  canBeAssignedToUsers: Type.Optional(Type.Boolean()),
  canBeAssignedToAgents: Type.Optional(Type.Boolean()),
  canBeAssignedToApiKeys: Type.Optional(Type.Boolean()),
  canUpdateAllSettings: Type.Optional(Type.Boolean()),
  canAccessAllTools: Type.Optional(Type.Boolean()),
  canReadAllObjectRecords: Type.Optional(Type.Boolean()),
  canUpdateAllObjectRecords: Type.Optional(Type.Boolean()),
  canSoftDeleteAllObjectRecords: Type.Optional(Type.Boolean()),
  canDestroyAllObjectRecords: Type.Optional(Type.Boolean()),
});

const UpdateRoleSchema = Type.Object({
  roleId: Type.String(),
  label: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  icon: Type.Optional(Type.String()),
  canBeAssignedToUsers: Type.Optional(Type.Boolean()),
  canBeAssignedToAgents: Type.Optional(Type.Boolean()),
  canBeAssignedToApiKeys: Type.Optional(Type.Boolean()),
  canUpdateAllSettings: Type.Optional(Type.Boolean()),
  canAccessAllTools: Type.Optional(Type.Boolean()),
  canReadAllObjectRecords: Type.Optional(Type.Boolean()),
  canUpdateAllObjectRecords: Type.Optional(Type.Boolean()),
  canSoftDeleteAllObjectRecords: Type.Optional(Type.Boolean()),
  canDestroyAllObjectRecords: Type.Optional(Type.Boolean()),
});

const DeleteRoleSchema = RoleIdParam;

// ---------------------------------------------------------------------------
// Schemas — Assignments
// ---------------------------------------------------------------------------

const AssignWorkspaceMemberSchema = Type.Object({
  workspaceMemberId: Type.String(),
  roleId: Type.String(),
});

const AssignAgentSchema = Type.Object({
  agentId: Type.String(),
  roleId: Type.String(),
});

const RevokeAgentSchema = Type.Object({ agentId: Type.String() });

const AssignApiKeySchema = Type.Object({
  apiKeyId: Type.String(),
  roleId: Type.String(),
});

// ---------------------------------------------------------------------------
// Schemas — Permission upserts
// ---------------------------------------------------------------------------

const ObjectPermissionsUpsertSchema = Type.Object({
  roleId: Type.String(),
  objectPermissions: Type.Array(
    Type.Object({
      objectMetadataId: Type.String(),
      canReadObjectRecords: Type.Optional(Type.Boolean()),
      canUpdateObjectRecords: Type.Optional(Type.Boolean()),
      canSoftDeleteObjectRecords: Type.Optional(Type.Boolean()),
      canDestroyObjectRecords: Type.Optional(Type.Boolean()),
    }),
    { minItems: 1 },
  ),
});

const FieldPermissionsUpsertSchema = Type.Object({
  roleId: Type.String(),
  fieldPermissions: Type.Array(
    Type.Object({
      objectMetadataId: Type.String(),
      fieldMetadataId: Type.String(),
      canReadFieldValue: Type.Optional(Type.Boolean()),
      canUpdateFieldValue: Type.Optional(Type.Boolean()),
    }),
    { minItems: 1 },
  ),
});

const PermissionFlagsUpsertSchema = Type.Object({
  roleId: Type.String(),
  permissionFlagKeys: Type.Array(PermissionFlagTypeSchema, {
    minItems: 0,
    description:
      "FULL replacement set of granted flags. Anything not listed is " +
      "REVOKED. Pass an empty array to clear every flag.",
  }),
});

const RowLevelPredicatesUpsertSchema = Type.Object({
  roleId: Type.String(),
  objectMetadataId: Type.String({
    description: "Target object the predicates apply to.",
  }),
  predicates: Type.Array(
    Type.Object({
      id: Type.Optional(
        Type.String({
          description: "Predicate UUID — supply when editing in place.",
        }),
      ),
      fieldMetadataId: Type.String(),
      operand: RowLevelPredicateOperandSchema,
      value: Type.Optional(Type.Any()),
      subFieldName: Type.Optional(Type.String()),
      workspaceMemberFieldMetadataId: Type.Optional(Type.String()),
      workspaceMemberSubFieldName: Type.Optional(Type.String()),
      rowLevelPermissionPredicateGroupId: Type.Optional(Type.String()),
      positionInRowLevelPermissionPredicateGroup: Type.Optional(Type.Number()),
    }),
    { minItems: 0 },
  ),
  predicateGroups: Type.Array(
    Type.Object({
      id: Type.Optional(Type.String()),
      objectMetadataId: Type.String(),
      parentRowLevelPermissionPredicateGroupId: Type.Optional(Type.String()),
      logicalOperator: PredicateGroupLogicalOperatorSchema,
      positionInRowLevelPermissionPredicateGroup: Type.Optional(Type.Number()),
    }),
    { minItems: 0 },
  ),
});

// ---------------------------------------------------------------------------
// Tool builder
// ---------------------------------------------------------------------------

export function buildRolesTools(client: TwentyClient) {
  return [
    defineTwentyTool(
      {
        name: "twenty_roles_list",
        description:
          "List every role in the workspace. Returns each role's flags " +
          "and assignment toggles, plus references to its " +
          "objectPermissions / fieldPermissions / permissionFlags / " +
          "rowLevelPermissionPredicates collections (use the " +
          "twenty_role_get to drill in).",
        parameters: Type.Object({}),
        run: async (_params, c, signal) => {
          const data = await c.postGraphQL<{ getRoles: RoleResp[] }>(
            `query Roles { getRoles { ${ROLE_FRAGMENT} } }`,
            {},
            { signal },
          );
          const roles = data?.getRoles ?? [];
          return { count: roles.length, roles };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_role_get",
        description:
          "Fetch a single role by id, with its objectPermissions, " +
          "fieldPermissions, permissionFlags, and " +
          "rowLevelPermissionPredicates joined. Twenty does not expose " +
          "a getRole(id) resolver, so the plugin filters the full " +
          "getRoles list client-side. Throws when no role matches.",
        parameters: RoleIdParam,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            getRoles: Array<
              RoleResp & {
                objectPermissions: unknown[];
                fieldPermissions: unknown[];
                permissionFlags: unknown[];
                rowLevelPermissionPredicates: unknown[];
                rowLevelPermissionPredicateGroups: unknown[];
              }
            >;
          }>(
            `query RolesAll {
              getRoles {
                ${ROLE_FRAGMENT}
                objectPermissions {
                  objectMetadataId
                  canReadObjectRecords canUpdateObjectRecords
                  canSoftDeleteObjectRecords canDestroyObjectRecords
                  restrictedFields
                }
                fieldPermissions {
                  id objectMetadataId fieldMetadataId roleId
                  canReadFieldValue canUpdateFieldValue
                }
                permissionFlags { id roleId flag }
                rowLevelPermissionPredicates {
                  id roleId fieldMetadataId objectMetadataId operand value
                  subFieldName rowLevelPermissionPredicateGroupId
                }
                rowLevelPermissionPredicateGroups {
                  id roleId objectMetadataId logicalOperator
                  parentRowLevelPermissionPredicateGroupId
                }
              }
            }`,
            {},
            { signal },
          );
          const role = (data?.getRoles ?? []).find(
            (r) => r.id === params.roleId,
          );
          if (!role) {
            throw new Error(`Role ${params.roleId} not found`);
          }
          return role;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_role_create",
        description:
          "Create a new role. Required: `label`. All boolean flags " +
          "default to `false` server-side — supply only the ones the " +
          "role should grant. **Approval-gated CRITICAL** — every new " +
          "role expands the workspace's permission surface.",
        mutates: true,
        parameters: CreateRoleSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{ createOneRole: RoleResp }>(
            `mutation CreateRole($input: CreateRoleInput!) {
              createOneRole(createRoleInput: $input) { ${ROLE_FRAGMENT} }
            }`,
            { input: params },
            { signal },
          );
          return data.createOneRole;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_role_update",
        description:
          "Patch a role's flags, label, description, or icon. Only " +
          "fields you supply are modified. **Approval-gated CRITICAL** — " +
          "every flag toggled flows through to every assignee.",
        mutates: true,
        parameters: UpdateRoleSchema,
        run: async (params, c, signal) => {
          const { roleId, ...update } = params;
          const data = await c.postGraphQL<{ updateOneRole: RoleResp }>(
            `mutation UpdateRole($input: UpdateRoleInput!) {
              updateOneRole(updateRoleInput: $input) { ${ROLE_FRAGMENT} }
            }`,
            { input: { id: roleId, update } },
            { signal },
          );
          return data.updateOneRole;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_role_delete",
        description:
          "Delete a role. Workspace members / agents / api keys " +
          "previously assigned to this role become role-less and fall " +
          "back to the workspace `defaultRoleId`. Returns the deleted " +
          "id. **Approval-gated CRITICAL** — denies all access for " +
          "previously-assigned principals until reassigned.",
        mutates: true,
        parameters: DeleteRoleSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{ deleteOneRole: string }>(
            `mutation DeleteRole($roleId: UUID!) {
              deleteOneRole(roleId: $roleId)
            }`,
            { roleId: params.roleId },
            { signal },
          );
          return { roleId: params.roleId, deletedId: data.deleteOneRole };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_role_assign_workspace_member",
        description:
          "Assign a role to a workspace member (human user). Replaces " +
          "the member's previous role atomically. Approval-gated.",
        mutates: true,
        parameters: AssignWorkspaceMemberSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            updateWorkspaceMemberRole: { id: string };
          }>(
            `mutation AssignMember(
              $workspaceMemberId: UUID!, $roleId: UUID!
            ) {
              updateWorkspaceMemberRole(
                workspaceMemberId: $workspaceMemberId, roleId: $roleId
              ) { id }
            }`,
            params,
            { signal },
          );
          return data.updateWorkspaceMemberRole;
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_role_assign_agent",
        description:
          "Assign a role to an agent (LLM principal). Approval-gated — " +
          "agents act on behalf of code, not humans, and an over-" +
          "permissive role can run unsupervised.",
        mutates: true,
        parameters: AssignAgentSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            assignRoleToAgent: boolean;
          }>(
            `mutation AssignAgent(
              $agentId: UUID!, $roleId: UUID!
            ) { assignRoleToAgent(agentId: $agentId, roleId: $roleId) }`,
            params,
            { signal },
          );
          return { agentId: params.agentId, assigned: data.assignRoleToAgent };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_role_revoke_agent",
        description:
          "Remove the role assignment from an agent. The agent will " +
          "fall back to the workspace `defaultRoleId`. Approval-gated.",
        mutates: true,
        parameters: RevokeAgentSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{ removeRoleFromAgent: boolean }>(
            `mutation RevokeAgent($agentId: UUID!) {
              removeRoleFromAgent(agentId: $agentId)
            }`,
            params,
            { signal },
          );
          return { agentId: params.agentId, removed: data.removeRoleFromAgent };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_role_assign_api_key",
        description:
          "Assign a role to an API key. Approval-gated — API keys are " +
          "long-lived credentials and the role they carry persists " +
          "across the key's lifetime.",
        mutates: true,
        parameters: AssignApiKeySchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{ assignRoleToApiKey: boolean }>(
            `mutation AssignApiKey(
              $apiKeyId: UUID!, $roleId: UUID!
            ) { assignRoleToApiKey(apiKeyId: $apiKeyId, roleId: $roleId) }`,
            params,
            { signal },
          );
          return {
            apiKeyId: params.apiKeyId,
            assigned: data.assignRoleToApiKey,
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_role_object_permissions_upsert",
        description:
          "Upsert object-level permissions on a role. Each entry " +
          "overrides the global Role flags for a specific " +
          "objectMetadataId. Approval-gated CRITICAL.",
        mutates: true,
        parameters: ObjectPermissionsUpsertSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            upsertObjectPermissions: Array<Record<string, unknown>>;
          }>(
            `mutation UpsertObjPerms(
              $input: UpsertObjectPermissionsInput!
            ) {
              upsertObjectPermissions(upsertObjectPermissionsInput: $input) {
                objectMetadataId canReadObjectRecords canUpdateObjectRecords
                canSoftDeleteObjectRecords canDestroyObjectRecords
              }
            }`,
            { input: params },
            { signal },
          );
          return {
            roleId: params.roleId,
            count: data.upsertObjectPermissions?.length ?? 0,
            objectPermissions: data.upsertObjectPermissions,
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_role_field_permissions_upsert",
        description:
          "Upsert field-level permissions on a role. Each entry " +
          "overrides the parent ObjectPermission for a specific " +
          "fieldMetadataId (canRead / canUpdate). Approval-gated " +
          "CRITICAL.",
        mutates: true,
        parameters: FieldPermissionsUpsertSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            upsertFieldPermissions: Array<Record<string, unknown>>;
          }>(
            `mutation UpsertFieldPerms(
              $input: UpsertFieldPermissionsInput!
            ) {
              upsertFieldPermissions(upsertFieldPermissionsInput: $input) {
                id objectMetadataId fieldMetadataId roleId
                canReadFieldValue canUpdateFieldValue
              }
            }`,
            { input: params },
            { signal },
          );
          return {
            roleId: params.roleId,
            count: data.upsertFieldPermissions?.length ?? 0,
            fieldPermissions: data.upsertFieldPermissions,
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_role_permission_flags_upsert",
        description:
          "Replace the granted PermissionFlag set for a role. The full " +
          "set of `permissionFlagKeys` REPLACES whatever was previously " +
          "granted — anything missing from the array is REVOKED. Pass " +
          "an empty array to clear every flag. Approval-gated CRITICAL.",
        mutates: true,
        parameters: PermissionFlagsUpsertSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            upsertPermissionFlags: Array<{ flag: string }>;
          }>(
            `mutation UpsertFlags(
              $input: UpsertPermissionFlagsInput!
            ) {
              upsertPermissionFlags(upsertPermissionFlagsInput: $input) {
                id roleId flag
              }
            }`,
            { input: params },
            { signal },
          );
          return {
            roleId: params.roleId,
            grantedFlags: (data.upsertPermissionFlags ?? []).map((f) => f.flag),
          };
        },
      },
      client,
    ),

    defineTwentyTool(
      {
        name: "twenty_role_row_level_predicates_upsert",
        description:
          "Upsert row-level permission predicates (and their containing " +
          "predicate groups) on a role + object pair. Predicates " +
          "compose into an AND/OR boolean tree that filters which " +
          "records the role can see / modify. Approval-gated CRITICAL " +
          "— a wrong predicate can hide essential records or expose PII.",
        mutates: true,
        parameters: RowLevelPredicatesUpsertSchema,
        run: async (params, c, signal) => {
          const data = await c.postGraphQL<{
            upsertRowLevelPermissionPredicates: {
              predicates: Array<{ id: string }>;
              predicateGroups: Array<{ id: string }>;
            };
          }>(
            `mutation UpsertRLP(
              $input: UpsertRowLevelPermissionPredicatesInput!
            ) {
              upsertRowLevelPermissionPredicates(input: $input) {
                predicates { id }
                predicateGroups { id }
              }
            }`,
            { input: params },
            { signal },
          );
          return {
            roleId: params.roleId,
            objectMetadataId: params.objectMetadataId,
            predicateCount:
              data.upsertRowLevelPermissionPredicates?.predicates?.length ?? 0,
            groupCount:
              data.upsertRowLevelPermissionPredicates?.predicateGroups?.length ??
              0,
          };
        },
      },
      client,
    ),
  ];
}
