// Twenty bulk import (P4b) — `twenty_bulk_import_csv`.
//
// Reads a CSV from a path on disk and posts the records to Twenty's batch
// endpoint for the chosen entity. Twenty's REST API exposes
//   POST /rest/batch/<entity>      → 201 { data: { create<Entities>: [...] } }
// with a body shaped as `array of records`. Per the OpenAPI we batch up to
// MAX_BATCH_SIZE records per call (Twenty does not document a hard cap;
// 60 mirrors the default page size from the read endpoints — keeps the
// request payload bounded and aligns with the rest of the plugin).
//
// SECURITY (CRITICAL):
//   The path supplied by the agent must canonicalise to a directory
//   listed in `config.allowedImportPaths` (default: `/home/node/.openclaw/`,
//   `/tmp/`). Path traversal (`/tmp/../etc/passwd`) is defeated by
//   resolving both sides via `path.resolve()` BEFORE comparing — a naïve
//   `startsWith("/tmp/")` would let `/tmp/../etc/passwd` through.
//
// CSV PARSER:
//   Inline RFC 4180 minimal parser (~50 lines). Handles double-quote
//   escaping, embedded commas/newlines inside quotes, and CRLF line
//   endings. Anything more exotic (multi-char delimiters, custom
//   quoting) is out of scope — the spec mandates the operator simplifies
//   the CSV, and we throw with a clear message rather than guess.

import * as fs from "node:fs";
import * as path from "node:path";

import { Type, type Static } from "@sinclair/typebox";

import { defineTwentyTool } from "./_factory.js";
import type { TwentyClient } from "../twenty-client.js";

const ENTITY_TO_BATCH_RESPONSE_KEY: Record<string, string> = {
  people: "createPeople",
  companies: "createCompanies",
  opportunities: "createOpportunities",
  notes: "createNotes",
  tasks: "createTasks",
};

const ENTITY_NAMES = Object.keys(ENTITY_TO_BATCH_RESPONSE_KEY);

const MAX_BATCH_SIZE = 60;
const MAX_RECORDS_HARD_CAP = 5000;

const BulkImportCsvSchema = Type.Object({
  csv_path: Type.String({
    description:
      "Absolute path to the CSV file. Must be inside one of " +
      "`config.allowedImportPaths` (default: `/home/node/.openclaw/`, " +
      "`/tmp/`) — outside paths are rejected before any I/O.",
  }),
  entity: Type.Union(
    ENTITY_NAMES.map((n) => Type.Literal(n)),
    {
      description:
        "Twenty object type to import into. One of: " + ENTITY_NAMES.join(", "),
    },
  ),
  mapping: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        "Optional `{ csvColumn: \"twenty.field.path\" }` map. When omitted, " +
        "CSV column names are used as-is (identity mapping). Dotted target " +
        "paths rebuild nested Twenty objects (e.g. `name.firstName`).",
    }),
  ),
  dry_run: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "When true, parse the CSV and emit the records the import WOULD " +
        "send, without making any POST. Still subject to `readOnly` because " +
        "the tool is tagged `mutates: true` (defensive default).",
    }),
  ),
});

type BulkImportCsvInput = Static<typeof BulkImportCsvSchema>;

interface ResolvedAllowedPaths {
  /**
   * Canonical resolved path entries (directories or files). Trailing slash
   * is intentionally stripped — we test with `+ path.sep` when needed.
   */
  canonical: string[];
}

/**
 * Resolve every entry in `allowedImportPaths` to its canonical absolute
 * form so the validation step can do a strict `startsWith` against
 * the canonical csv path. Empty/blank entries are dropped.
 */
function resolveAllowedPaths(
  allowed: readonly string[] | undefined,
): ResolvedAllowedPaths {
  const list = (allowed ?? []).filter((p) => typeof p === "string" && p.trim());
  return {
    canonical: list.map((p) => path.resolve(p)),
  };
}

/**
 * Validate that `csvPath` (as supplied by the agent) canonicalises into
 * one of the `allowed` directories. Throws on failure with a message the
 * agent can act on.
 *
 * Two threats addressed:
 *   1. Path traversal — `/tmp/../etc/passwd` would slip past a naïve
 *      `startsWith("/tmp/")`. Defeated by `path.resolve()`.
 *   2. Symlink bypass — `ln -s /etc/passwd /tmp/sneaky.csv` would slip
 *      past `path.resolve()` (which only resolves `..`, not symlinks).
 *      Defeated by `fs.realpathSync()`, which follows every link in the
 *      chain. The OpenClaw plugin sandbox doc mandates symlink
 *      resolution as part of "cannot exit the root of their package
 *      directory" — we follow that pattern here for the import surface.
 *
 * `realpathSync` requires the file to exist; we surface ENOENT as a
 * clear "file not found" rather than a generic permission error.
 */
function assertCsvPathAllowed(
  csvPath: string,
  allowed: ResolvedAllowedPaths,
): string {
  if (typeof csvPath !== "string" || csvPath.trim() === "") {
    throw new Error("csv_path must be a non-empty absolute path string");
  }
  if (allowed.canonical.length === 0) {
    throw new Error(
      "csv_path rejected: `config.allowedImportPaths` is empty — set at " +
        "least one allowed directory before using twenty_bulk_import_csv",
    );
  }

  // Step 1: resolve `..` segments via path.resolve. This catches the
  // direct-outside-path and traversal cases BEFORE we touch the disk —
  // which is what the test suite asserts (zero HTTP, zero file I/O).
  const lexical = path.resolve(csvPath);
  const matches = (target: string) =>
    allowed.canonical.some((dir) => {
      const dirSep = dir.endsWith(path.sep) ? dir : dir + path.sep;
      return target === dir || target.startsWith(dirSep);
    });

  if (!matches(lexical)) {
    throw new Error(
      `csv_path "${csvPath}" (resolved to "${lexical}") is outside ` +
        `allowedImportPaths [${allowed.canonical.join(", ")}]. ` +
        `Move the file inside an allowed directory or update ` +
        `plugins.entries.twenty-openclaw.config.allowedImportPaths.`,
    );
  }

  // Step 2: resolve symlinks. The lexical path already passed the
  // whitelist check; if `realpathSync` resolves it to somewhere else
  // (e.g. /tmp/sneaky.csv → /etc/passwd), we re-check and reject.
  let real = lexical;
  try {
    real = fs.realpathSync(lexical);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENOENT")) {
      throw new Error(`csv_path "${csvPath}" does not exist on disk.`);
    }
    throw new Error(`csv_path "${csvPath}" cannot be canonicalised: ${msg}`);
  }
  if (real !== lexical && !matches(real)) {
    throw new Error(
      `csv_path "${csvPath}" resolves through a symlink to "${real}", ` +
        `which is outside allowedImportPaths ` +
        `[${allowed.canonical.join(", ")}]. Refusing to read.`,
    );
  }

  return real;
}

/**
 * Minimal RFC 4180-compatible CSV parser.
 *
 * - Fields are separated by `,`.
 * - Fields wrapped in `"..."` may contain commas, newlines, and `""`
 *   (escaped double-quote).
 * - Outside quotes, `\r\n` and `\n` end a record; `\r` alone is treated
 *   as a line ending too (for legacy macOS exports).
 * - Returns an array of rows, each row being an array of cells.
 *
 * Throws on unterminated quoted fields. Anything more exotic
 * (multi-char delimiters, custom quoting) is intentionally out of scope.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const len = text.length;

  for (let i = 0; i < len; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          // Escaped double-quote inside quoted field.
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      // Skip the LF when we just saw CR (handle CRLF as a single break).
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      // Skip empty trailing rows (typical of files ending in a newline).
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }

  if (inQuotes) {
    throw new Error(
      "CSV parse error: unterminated quoted field. Simplify the CSV or " +
        "remove embedded line breaks before retrying.",
    );
  }

  // Flush the final cell/row if the file does not end with a newline.
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }

  return rows;
}

/**
 * Set a value on `obj` at the dotted path, creating intermediate objects
 * as needed. Used to translate a flat CSV column (`name.firstName`) back
 * into Twenty's nested record shape (`{ name: { firstName: "..." } }`).
 */
function setDottedPath(
  obj: Record<string, unknown>,
  dotted: string,
  value: unknown,
): void {
  const parts = dotted.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const nxt = cur[key];
    if (nxt && typeof nxt === "object" && !Array.isArray(nxt)) {
      cur = nxt as Record<string, unknown>;
    } else {
      const fresh: Record<string, unknown> = {};
      cur[key] = fresh;
      cur = fresh;
    }
  }
  cur[parts[parts.length - 1]!] = value;
}

/**
 * Build Twenty records from parsed CSV rows. Empty cells are dropped
 * (Twenty's create endpoint handles missing fields better than empty
 * strings — the latter clobbers existing values on update, which we are
 * NOT doing here, but the pattern keeps payloads slim).
 */
function buildRecords(
  rows: string[][],
  headers: string[],
  mapping: Record<string, string> | undefined,
): {
  records: Record<string, unknown>[];
  skipped: { row: number; reason: string }[];
} {
  const records: Record<string, unknown>[] = [];
  const skipped: { row: number; reason: string }[] = [];

  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r]!;
    if (cells.length === 0 || (cells.length === 1 && cells[0] === "")) {
      skipped.push({ row: r + 2, reason: "empty row" });
      continue;
    }
    const record: Record<string, unknown> = {};
    let hasContent = false;
    for (let c = 0; c < headers.length; c++) {
      const header = headers[c]!;
      const value = cells[c] ?? "";
      if (value === "") continue;
      const target = mapping?.[header] ?? header;
      setDottedPath(record, target, value);
      hasContent = true;
    }
    if (!hasContent) {
      skipped.push({ row: r + 2, reason: "all cells empty" });
      continue;
    }
    records.push(record);
  }

  return { records, skipped };
}

interface BatchCreateResponse {
  data?: Record<string, unknown>;
}

export interface BulkImportToolFactoryOptions {
  /**
   * Resolved import paths from the plugin config. The factory keeps a
   * reference and resolves them once at registration time so subsequent
   * tool calls do a cheap canonical comparison.
   */
  allowedImportPaths: readonly string[];
}

export function buildBulkTools(
  client: TwentyClient,
  opts: BulkImportToolFactoryOptions,
) {
  const allowed = resolveAllowedPaths(opts.allowedImportPaths);

  return [
    defineTwentyTool(
      {
        name: "twenty_bulk_import_csv",
        description:
          "Import records from a CSV file into a Twenty entity (people, " +
          "companies, opportunities, notes, tasks). Path MUST be inside " +
          "`config.allowedImportPaths` for security. Batches the records " +
          `${MAX_BATCH_SIZE} at a time against \`/rest/batch/<entity>\`. ` +
          `Hard cap: ${MAX_RECORDS_HARD_CAP} records per call. ` +
          "Use `mapping` to translate CSV columns to dotted Twenty field " +
          "paths (e.g. `firstName` → `name.firstName`). Use `dry_run=true` " +
          "to validate the parse without POSTing.",
        // mutates: true so the read-only flag still blocks the call. Even
        // a dry_run parse is conservatively gated — the side-effect is the
        // file read, and a misuse of the tool against a file outside the
        // workspace is the primary attack we care about. The `readOnly`
        // operator wants ALL twenty_* writes off, including dry-runs that
        // could leak file contents.
        mutates: true,
        parameters: BulkImportCsvSchema,
        run: async (params: BulkImportCsvInput, c, signal) => {
          const responseKey = ENTITY_TO_BATCH_RESPONSE_KEY[params.entity];
          if (!responseKey) {
            throw new Error(
              `twenty_bulk_import_csv: unsupported entity "${params.entity}"`,
            );
          }

          // 1. Path validation — REJECT before any disk I/O.
          const resolvedPath = assertCsvPathAllowed(params.csv_path, allowed);

          // 2. Read the file. Errors propagate as TwentyApiError-equivalent
          // through the factory's catch (we throw plain Error here so the
          // factory wraps it as a generic failure).
          const text = fs.readFileSync(resolvedPath, "utf8");

          // 3. Parse + map.
          const rows = parseCsv(text);
          if (rows.length === 0) {
            return {
              imported: 0,
              failed: 0,
              dry_run: params.dry_run === true,
              parsed_count: 0,
              skipped: [],
              note: "CSV is empty",
            };
          }
          const headers = rows[0]!.map((h) => h.trim());
          if (headers.length === 0 || headers.every((h) => h === "")) {
            throw new Error("CSV has no header row");
          }
          const dataRows = rows.slice(1);
          if (dataRows.length > MAX_RECORDS_HARD_CAP) {
            throw new Error(
              `CSV contains ${dataRows.length} records, exceeding the ` +
                `hard cap of ${MAX_RECORDS_HARD_CAP}. Split the file or ` +
                `reduce the dataset.`,
            );
          }

          const { records, skipped } = buildRecords(
            dataRows,
            headers,
            params.mapping,
          );

          // 4. Dry-run path: stop here.
          if (params.dry_run === true) {
            return {
              imported: 0,
              failed: 0,
              dry_run: true,
              parsed_count: records.length,
              skipped,
              records,
            };
          }

          if (records.length === 0) {
            return {
              imported: 0,
              failed: 0,
              dry_run: false,
              parsed_count: 0,
              skipped,
              note: "No usable records in the CSV",
            };
          }

          // 5. Batch POST.
          const batchPath = `/rest/batch/${params.entity}`;
          const created: Record<string, unknown>[] = [];
          const errors: { batch: number; error: string }[] = [];
          let batchCount = 0;

          for (let i = 0; i < records.length; i += MAX_BATCH_SIZE) {
            batchCount += 1;
            const slice = records.slice(i, i + MAX_BATCH_SIZE);
            try {
              const resp = await c.request<BatchCreateResponse>(
                "POST",
                batchPath,
                { body: slice, signal },
              );
              const wrapped = resp?.data?.[responseKey];
              if (Array.isArray(wrapped)) {
                created.push(...(wrapped as Record<string, unknown>[]));
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              errors.push({ batch: batchCount, error: msg });
              // Continue with the remaining batches — partial success is
              // still useful (operator can re-run on the failed slice).
            }
          }

          return {
            imported: created.length,
            failed: records.length - created.length,
            dry_run: false,
            parsed_count: records.length,
            skipped,
            batches: batchCount,
            errors,
            created,
          };
        },
      },
      client,
    ),
  ];
}
