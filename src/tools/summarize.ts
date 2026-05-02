// Twenty relationship summary (P4b) — `twenty_summarize_relationship`.
//
// Returns the activity counts and timeline anchors for a single Person or
// Company over a rolling window. ZERO scoring, ZERO ranking — the agent
// reasons over the facts. The deliverable is a small, deterministic JSON
// object the agent can pass back into a prompt.
//
// Three parallel calls per invocation:
//   - GET /rest/noteTargets?filter=and(<targetField>[eq]:<id>,createdAt[gte]:<since>)&depth=1
//   - GET /rest/taskTargets?filter=and(<targetField>[eq]:<id>,createdAt[gte]:<since>)&depth=1
//   - GET /rest/calendarEventParticipants?filter=and(personId[eq]:<id>,createdAt[gte]:<since>)
//     (only when target_type == "Person" — Twenty does not expose a
//     `companyId` field on the participant join, so we skip this for
//     Company targets and surface `calendar_events: 0` with a note.)
//
// We cap each call at 200 records (Twenty's max page size). The window is
// expected to be short enough (≤ 365 days) that 200 entries per category
// is enough for almost every consultant timeline; if not, the agent falls
// back to the full `*_list` tools. Counts are exact only when
// `pageInfo.hasNextPage === false` — otherwise we surface `count_truncated`
// so the agent knows there is more.

import { Type } from "@sinclair/typebox";

import { defineTwentyTool } from "./_factory.js";
import type { TwentyClient } from "../twenty-client.js";

const TARGET_FIELD: Record<"Person" | "Company", string> = {
  Person: "targetPersonId",
  Company: "targetCompanyId",
};

const SUMMARIZE_PAGE_LIMIT = 200; // Twenty REST max
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

interface RawJoinTarget {
  id?: string;
  createdAt?: string;
  [key: string]: unknown;
}

interface RawJoinResponse<TKey extends string> {
  data?: { [K in TKey]?: RawJoinTarget[] };
  pageInfo?: {
    hasNextPage?: boolean;
    startCursor?: string | null;
    endCursor?: string | null;
  };
  totalCount?: number;
}

/**
 * Compute `now - days` as an ISO 8601 datetime string. Returned at second
 * granularity (the Twenty `createdAt[gte]` filter accepts ISO timestamps).
 */
function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

/**
 * Find the most recent / oldest `createdAt` across the join rows. Returns
 * `null` when none of the entries have a parseable date — defensive
 * against partial backfills.
 */
function timelineAnchors(rows: RawJoinTarget[][]): {
  first: string | null;
  last: string | null;
} {
  let first: number | null = null;
  let last: number | null = null;
  for (const set of rows) {
    for (const r of set) {
      const ts = typeof r.createdAt === "string" ? Date.parse(r.createdAt) : NaN;
      if (!Number.isFinite(ts)) continue;
      if (first === null || ts < first) first = ts;
      if (last === null || ts > last) last = ts;
    }
  }
  return {
    first: first === null ? null : new Date(first).toISOString(),
    last: last === null ? null : new Date(last).toISOString(),
  };
}

export function buildSummarizeTools(client: TwentyClient) {
  return [
    defineTwentyTool(
      {
        name: "twenty_summarize_relationship",
        description:
          "Summarize the activity timeline for a Person or Company over a " +
          "given window. Returns COUNTS and TIMESTAMPS only — no scoring, " +
          "no ranking. The agent reasons over the facts. Categories: " +
          "notes, tasks, and (Person only) calendar events. Each count " +
          "may be marked `truncated` when more records exist than " +
          "Twenty's per-call cap.",
        parameters: Type.Object({
          target_type: Type.Union(
            [Type.Literal("Person"), Type.Literal("Company")],
            { description: "Type of the record to summarise." },
          ),
          target_id: Type.String({
            description: "UUID of the target Person or Company.",
          }),
          days: Type.Optional(
            Type.Number({
              minimum: 1,
              maximum: MAX_DAYS,
              default: DEFAULT_DAYS,
              description:
                `Window length in days (default ${DEFAULT_DAYS}, max ${MAX_DAYS}).`,
            }),
          ),
        }),
        run: async (params, c, signal) => {
          const days = params.days ?? DEFAULT_DAYS;
          const since = isoDaysAgo(days);
          const targetField = TARGET_FIELD[params.target_type];

          // Twenty filter DSL: `and(field1[eq]:v,field2[gte]:v)` for AND
          // composition. Values containing colons or commas would need
          // quoting (`"..."`), but UUIDs and ISO timestamps are URL-safe
          // and quote-free. We still wrap the ISO timestamp in quotes per
          // the OpenAPI's `simple` example (`createdAt[gte]:"2023-01-01"`).
          const joinFilter = (idField: string, idValue: string) =>
            `and(${idField}[eq]:${idValue},createdAt[gte]:"${since}")`;

          // notes + tasks share the same target field naming convention.
          const noteFilter = joinFilter(targetField, params.target_id);
          const taskFilter = joinFilter(targetField, params.target_id);

          const noteCall = c.request<RawJoinResponse<"noteTargets">>(
            "GET",
            "/rest/noteTargets",
            {
              query: {
                filter: noteFilter,
                depth: 1,
                limit: SUMMARIZE_PAGE_LIMIT,
              },
              signal,
            },
          );
          const taskCall = c.request<RawJoinResponse<"taskTargets">>(
            "GET",
            "/rest/taskTargets",
            {
              query: {
                filter: taskFilter,
                depth: 1,
                limit: SUMMARIZE_PAGE_LIMIT,
              },
              signal,
            },
          );

          // calendarEventParticipants only has `personId` — no Company
          // shortcut. We document the gap on the response rather than
          // doing two-hop joins that would inflate the call count.
          let calendarCall: Promise<
            RawJoinResponse<"calendarEventParticipants"> | null
          > = Promise.resolve(null);
          if (params.target_type === "Person") {
            const calFilter =
              `and(personId[eq]:${params.target_id},createdAt[gte]:"${since}")`;
            calendarCall = c.request<
              RawJoinResponse<"calendarEventParticipants">
            >("GET", "/rest/calendarEventParticipants", {
              query: {
                filter: calFilter,
                depth: 1,
                limit: SUMMARIZE_PAGE_LIMIT,
              },
              signal,
            });
          }

          const [noteResp, taskResp, calResp] = await Promise.all([
            noteCall,
            taskCall,
            calendarCall,
          ]);

          const notes = noteResp?.data?.noteTargets ?? [];
          const tasks = taskResp?.data?.taskTargets ?? [];
          const cals = calResp?.data?.calendarEventParticipants ?? [];

          const anchors = timelineAnchors([notes, tasks, cals]);

          const noteTotal =
            typeof noteResp?.totalCount === "number"
              ? noteResp.totalCount
              : null;
          const taskTotal =
            typeof taskResp?.totalCount === "number"
              ? taskResp.totalCount
              : null;
          const calTotal =
            typeof calResp?.totalCount === "number"
              ? calResp.totalCount
              : null;

          const noteCount = noteTotal ?? notes.length;
          const taskCount = taskTotal ?? tasks.length;
          const calCount = calTotal ?? cals.length;

          return {
            target_type: params.target_type,
            target_id: params.target_id,
            window_days: days,
            window_start: since,
            counts: {
              notes: noteCount,
              tasks: taskCount,
              calendar_events: calCount,
            },
            // `truncated` indicates the timeline anchors and timestamps
            // are computed from a partial view. Two cases:
            //   1. Twenty returned a totalCount > what we fetched (we
            //      know there are more records than the cap allows).
            //   2. No totalCount in the response (older Twenty versions)
            //      AND the returned page hit the cap (likely truncated).
            // In both cases the agent should fall back to the per-entity
            // list tools for the full picture.
            truncated: {
              notes:
                noteTotal !== null
                  ? noteTotal > notes.length
                  : notes.length === SUMMARIZE_PAGE_LIMIT,
              tasks:
                taskTotal !== null
                  ? taskTotal > tasks.length
                  : tasks.length === SUMMARIZE_PAGE_LIMIT,
              calendar_events:
                calTotal !== null
                  ? calTotal > cals.length
                  : cals.length === SUMMARIZE_PAGE_LIMIT,
            },
            first_activity_at: anchors.first,
            last_activity_at: anchors.last,
            total_count: noteCount + taskCount + calCount,
            ...(params.target_type === "Company"
              ? {
                  notes_company_calendar:
                    "calendar_events not available for Company targets — " +
                    "Twenty's calendarEventParticipants exposes only a " +
                    "personId field.",
                }
              : {}),
          };
        },
      },
      client,
    ),
  ];
}
