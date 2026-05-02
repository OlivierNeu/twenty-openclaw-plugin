// Twenty dedup helpers (P4b).
//
// Two read-only tools that surface duplicate-candidate groups WITHOUT
// touching the data:
//   - `twenty_people_find_similar` — fragment query (email, then name)
//     used by the agent to detect existing contacts before creating one.
//   - `twenty_people_dedup` / `twenty_companies_dedup` — group records that
//     share a strict identity key (primary email / primary domain).
//
// Design choices (deliberate, do not extend without scope review):
//   - STRICT matching only. No fuzzy library, no Levenshtein. Twenty's
//     `ilike` + `%fragment%` is good enough for the agent's pre-creation
//     check; deeper dedup is a job for a downstream pipeline.
//   - The dedup tools NEVER auto-merge. They return the grouping for the
//     agent to review and decide. Auto-merge is gated behind the future
//     `twenty_dedup_auto_merge` tool (already declared in
//     `approvalRequired` defaults).
//   - We page through `/rest/<entity>` ourselves rather than reusing
//     `buildExportTools` because we want to stop early as soon as `limit`
//     records have been scanned (export's hard cap is 10000; here we cap
//     at 500 to keep the in-memory grouping cheap).

import { Type } from "@sinclair/typebox";

import {
  defineTwentyTool,
  shapeListResponse,
  type ListOutput,
} from "./_factory.js";
import type { TwentyClient } from "../twenty-client.js";

const FIND_SIMILAR_DEFAULT_LIMIT = 10;
const FIND_SIMILAR_MAX_LIMIT = 50;
const DEDUP_DEFAULT_LIMIT = 200;
const DEDUP_MAX_LIMIT = 500;
const DEDUP_PAGE_LIMIT = 60; // Twenty REST default page size

interface RawListResponseShape {
  data?: Record<string, unknown>;
  pageInfo?: {
    hasNextPage?: boolean;
    startCursor?: string | null;
    endCursor?: string | null;
  };
  totalCount?: number;
}

/**
 * Walk the keys of a record using a dotted path (`name.firstName`,
 * `domainName.primaryLinkUrl`). Returns the leaf value or `undefined` when
 * any segment is missing or the value is `null`. Used to extract the
 * grouping key without forcing the caller to type-narrow nested objects.
 */
function readPath(record: Record<string, unknown>, dotted: string): unknown {
  const parts = dotted.split(".");
  let cur: unknown = record;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/**
 * Page through `/rest/<entity>` until either `limit` records have been
 * collected or `pageInfo.hasNextPage` flips false. Mirrors the export
 * tool's loop but with a much tighter cap (records live in a Map for
 * grouping, so we keep RAM bounded).
 */
async function paginateUpTo(
  client: TwentyClient,
  path: string,
  entityKey: string,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<{ records: Record<string, unknown>[]; pages: number }> {
  const records: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  let pages = 0;

  while (records.length < limit) {
    const query: Record<string, string | number | boolean | undefined> = {
      limit: Math.min(DEDUP_PAGE_LIMIT, limit - records.length),
    };
    if (cursor) query.startingAfter = cursor;

    const resp = await client.request<RawListResponseShape>("GET", path, {
      query,
      signal,
    });
    pages += 1;
    const shaped: ListOutput<Record<string, unknown>> =
      shapeListResponse<Record<string, unknown>>(resp, entityKey);

    for (const r of shaped.data) {
      records.push(r);
      if (records.length >= limit) break;
    }

    if (!shaped.pageInfo.hasNextPage || !shaped.pageInfo.endCursor) break;
    cursor = shaped.pageInfo.endCursor;
  }

  return { records, pages };
}

/**
 * Group records by a dotted key path. Records whose key resolves to
 * `undefined`, `null`, or an empty string are excluded — they are not a
 * dedup candidate. Keys are lower-cased so `Foo@Bar.com` collides with
 * `foo@bar.com` (typical operator expectation).
 */
function groupByKey(
  records: Record<string, unknown>[],
  keyPath: string,
): Map<string, Record<string, unknown>[]> {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const r of records) {
    const raw = readPath(r, keyPath);
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== "string") continue;
    const key = raw.trim().toLowerCase();
    if (key === "") continue;
    const existing = groups.get(key);
    if (existing) {
      existing.push(r);
    } else {
      groups.set(key, [r]);
    }
  }
  return groups;
}

export function buildDedupTools(client: TwentyClient) {
  return [
    // -------------------------------------------------------------------
    // twenty_people_find_similar
    // -------------------------------------------------------------------
    defineTwentyTool(
      {
        name: "twenty_people_find_similar",
        description:
          "Find People that look similar to a query fragment (email or " +
          "name). Used to detect existing contacts BEFORE creating " +
          "duplicates. Strict matching only — no fuzzy library. Two-pass " +
          "search: first by `emails.primaryEmail[ilike]:%query%`; if no " +
          "hit, fallback to " +
          "`or(name.firstName[ilike]:%query%,name.lastName[ilike]:%query%)`. " +
          "Returns up to `limit` candidates and the strategy that hit " +
          "(`email`, `name`, or `none`).",
        parameters: Type.Object({
          query: Type.String({
            description:
              "Fragment to match against email or first/last name (case-insensitive).",
          }),
          limit: Type.Optional(
            Type.Number({
              minimum: 1,
              maximum: FIND_SIMILAR_MAX_LIMIT,
              default: FIND_SIMILAR_DEFAULT_LIMIT,
              description:
                `Max candidates returned (default ${FIND_SIMILAR_DEFAULT_LIMIT}, max ${FIND_SIMILAR_MAX_LIMIT}).`,
            }),
          ),
        }),
        run: async (params, c, signal) => {
          const query = params.query.trim();
          if (query === "") {
            return {
              query: params.query,
              candidates: [],
              match_strategy: "none" as const,
              note: "Empty query — nothing to match.",
            };
          }
          const limit = params.limit ?? FIND_SIMILAR_DEFAULT_LIMIT;

          // Pass 1: email substring.
          // Twenty filter DSL accepts the like wildcard inside the value;
          // the OpenAPI examples wrap the value in double quotes (e.g.
          // `name[like]:"%value%"`) — we follow that convention. The DSL
          // value is NOT URL-encoded by us — `URLSearchParams` encodes
          // the whole `filter` value once.
          const emailFilter = `emails.primaryEmail[ilike]:"%${query}%"`;
          const emailResp = await c.request<RawListResponseShape>(
            "GET",
            "/rest/people",
            {
              query: { filter: emailFilter, limit, depth: 1 },
              signal,
            },
          );
          const byEmail = shapeListResponse<Record<string, unknown>>(
            emailResp,
            "people",
          );

          if (byEmail.data.length > 0) {
            return {
              query,
              candidates: byEmail.data,
              match_strategy: "email" as const,
            };
          }

          // Pass 2: OR on firstName / lastName.
          const nameFilter =
            `or(name.firstName[ilike]:"%${query}%",name.lastName[ilike]:"%${query}%")`;
          const nameResp = await c.request<RawListResponseShape>(
            "GET",
            "/rest/people",
            {
              query: { filter: nameFilter, limit, depth: 1 },
              signal,
            },
          );
          const byName = shapeListResponse<Record<string, unknown>>(
            nameResp,
            "people",
          );

          if (byName.data.length === 0) {
            return {
              query,
              candidates: [],
              match_strategy: "none" as const,
            };
          }

          // Dedupe by id in case Twenty returns overlap between the two
          // passes (defensive — pass 2 only runs when pass 1 was empty,
          // so overlap should be impossible, but guards against future
          // refactors where both passes might run).
          const seen = new Set<string>();
          const candidates: Record<string, unknown>[] = [];
          for (const r of byName.data) {
            const id = typeof r.id === "string" ? r.id : null;
            if (id && seen.has(id)) continue;
            if (id) seen.add(id);
            candidates.push(r);
          }

          return {
            query,
            candidates,
            match_strategy: "name" as const,
          };
        },
      },
      client,
    ),

    // -------------------------------------------------------------------
    // twenty_people_dedup
    // -------------------------------------------------------------------
    defineTwentyTool(
      {
        name: "twenty_people_dedup",
        description:
          "Scan up to `limit` People records and return groups that share " +
          "the same primary email (strict, case-insensitive). Returns the " +
          "groups for review — does NOT auto-merge. Use this before " +
          "importing data or to surface manual cleanup candidates. Group " +
          "key: `emails.primaryEmail` (records with empty/null email are " +
          "skipped).",
        parameters: Type.Object({
          limit: Type.Optional(
            Type.Number({
              minimum: 1,
              maximum: DEDUP_MAX_LIMIT,
              default: DEDUP_DEFAULT_LIMIT,
              description:
                `Max records to scan (default ${DEDUP_DEFAULT_LIMIT}, max ${DEDUP_MAX_LIMIT}). ` +
                `Bigger workspaces should run this multiple times with filters.`,
            }),
          ),
        }),
        run: async (params, c, signal) => {
          const limit = params.limit ?? DEDUP_DEFAULT_LIMIT;
          const { records, pages } = await paginateUpTo(
            c,
            "/rest/people",
            "people",
            limit,
            signal,
          );
          const groups = groupByKey(records, "emails.primaryEmail");
          const dupGroups = [...groups.entries()]
            .filter(([, items]) => items.length >= 2)
            .map(([key, items]) => ({
              group_key: key,
              count: items.length,
              records: items,
            }));
          return {
            scanned: records.length,
            pages,
            groups: dupGroups,
            duplicate_count: dupGroups.length,
          };
        },
      },
      client,
    ),

    // -------------------------------------------------------------------
    // twenty_companies_dedup
    // -------------------------------------------------------------------
    defineTwentyTool(
      {
        name: "twenty_companies_dedup",
        description:
          "Scan up to `limit` Company records and return groups that share " +
          "the same primary domain URL (strict, case-insensitive). Returns " +
          "the groups for review — does NOT auto-merge. Group key: " +
          "`domainName.primaryLinkUrl` (records with empty/null domain " +
          "are skipped).",
        parameters: Type.Object({
          limit: Type.Optional(
            Type.Number({
              minimum: 1,
              maximum: DEDUP_MAX_LIMIT,
              default: DEDUP_DEFAULT_LIMIT,
              description:
                `Max records to scan (default ${DEDUP_DEFAULT_LIMIT}, max ${DEDUP_MAX_LIMIT}).`,
            }),
          ),
        }),
        run: async (params, c, signal) => {
          const limit = params.limit ?? DEDUP_DEFAULT_LIMIT;
          const { records, pages } = await paginateUpTo(
            c,
            "/rest/companies",
            "companies",
            limit,
            signal,
          );
          const groups = groupByKey(records, "domainName.primaryLinkUrl");
          const dupGroups = [...groups.entries()]
            .filter(([, items]) => items.length >= 2)
            .map(([key, items]) => ({
              group_key: key,
              count: items.length,
              records: items,
            }));
          return {
            scanned: records.length,
            pages,
            groups: dupGroups,
            duplicate_count: dupGroups.length,
          };
        },
      },
      client,
    ),
  ];
}
