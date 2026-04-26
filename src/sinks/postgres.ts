/**
 * Postgres sink — write spans to a Postgres table.
 *
 * Two value props:
 *
 *   1. **Queryable canonical archive.** S3 is cheap blob storage; Postgres
 *      lets you JOIN spans with your business tables, run aggregate
 *      queries (p99 by tool, error rate by model, cost by user), and
 *      drive admin debug endpoints without standing up another service.
 *
 *   2. **Replaces vendor-specific span tables.** If you previously
 *      bootstrapped a `spans`-like table from your engine state via
 *      triggers (Daslab pattern), this sink writes directly so you can
 *      retire the trigger when ready.
 *
 * Default schema is OTel-canonical:
 *
 *   span_id, trace_id, parent_span_id,
 *   name, kind, status_code, status_message,
 *   start_time, end_time,
 *   attributes JSONB, events JSONB, links JSONB,
 *   resource JSONB, scope JSONB
 *
 * For non-default schemas (Daslab's spans table has engine-state columns
 * like exec_status, executor, waits_for) pass a custom `columnMapper`.
 *
 * Connection options:
 *   - `query`: bring your own query function (any pg client works)
 *   - `url`: convenience — we lazy-import the `postgres` package
 *
 * `postgres` is an OPTIONAL peer dependency. Install only if you use the
 * `url` form; if you use `query` you can use `pg` or any other driver.
 *
 * Usage:
 *
 *   import { postgres as postgresSink, defaultSchemaSql } from 'agent-otel/sinks/postgres';
 *
 *   // First time: create the table
 *   await db.query(defaultSchemaSql('spans'));
 *
 *   const sink = postgresSink({
 *     url: process.env.DATABASE_URL!,
 *     table: 'spans',
 *   });
 *
 * Or with a custom schema (e.g. matching Daslab's spans table):
 *
 *   const sink = postgresSink({
 *     url: process.env.DATABASE_URL!,
 *     table: 'spans',
 *     columnMapper: (s) => ({
 *       span_id: s.spanId,
 *       trace_id: s.traceId,
 *       parent_span_id: s.parentSpanId,
 *       name: s.name,
 *       kind: s.kind,
 *       status_code: s.status.code,
 *       status_message: s.status.message,
 *       start_time: new Date(s.startTimeUnixNano / 1e6),
 *       end_time:   new Date(s.endTimeUnixNano   / 1e6),
 *       attributes: s.attributes,
 *       // engine-state columns Daslab adds:
 *       exec_status: s.attributes.exec_status ?? 'completed',
 *       executor:    s.attributes.executor    ?? 'tool',
 *       cost:        s.attributes['llm.cost.total'],
 *     }),
 *   });
 */

import type { RoutedSpan, Sink } from '../types.js';

/**
 * Minimal duck type that any pg-style driver satisfies. `pg`, `postgres`,
 * `Bun.sql`, custom query helpers — all expose `(sql, params) => Promise<rows>`
 * if you wrap them. The sink calls only this method.
 */
export type PostgresQueryFn = (sql: string, params?: unknown[]) => Promise<unknown>;

export interface PostgresSinkOptions {
  /** Bring your own query function. Any pg-style client works. */
  query?: PostgresQueryFn;
  /**
   * Postgres connection URL — used only when `query` is not provided.
   * Lazy-imports the `postgres` npm package; install it explicitly:
   *   npm install postgres
   */
  url?: string;
  /** Target table. Default: 'spans'. */
  table?: string;
  /**
   * Map a RoutedSpan to a row object. Default writes the OTel-canonical
   * columns described in `defaultSchemaSql`. Override for custom schemas.
   * Return `null` to skip a span (e.g. filter by attribute).
   */
  columnMapper?: (span: RoutedSpan) => Record<string, unknown> | null;
  /** Number of rows per INSERT batch. Default: 100. */
  batchSize?: number;
  /** Max ms between flushes. Default: 5000. */
  flushIntervalMs?: number;
  /**
   * ON CONFLICT behavior. Default: `'merge'` — `ON CONFLICT (span_id) DO UPDATE`
   * with attribute-jsonb merge for compatibility with engine-side triggers
   * that may write the same span_id first.
   * `'ignore'` uses `DO NOTHING`. `'error'` lets duplicates raise.
   */
  conflictMode?: 'merge' | 'ignore' | 'error';
  /**
   * The conflict-target column. Default: 'span_id'. Match this to whichever
   * column has a UNIQUE / PRIMARY KEY constraint in your table.
   */
  conflictKey?: string;
  /** Override sink name (default: 'postgres'). */
  name?: string;
}

/**
 * Default OTel-canonical column mapper. Produces a row whose keys match
 * `defaultSchemaSql` exactly.
 */
export function defaultColumnMapper(s: RoutedSpan): Record<string, unknown> {
  return {
    span_id:        s.spanId,
    trace_id:       s.traceId,
    parent_span_id: s.parentSpanId ?? null,
    name:           s.name,
    kind:           s.kind,
    status_code:    s.status.code,
    status_message: s.status.message ?? null,
    start_time:     new Date(s.startTimeUnixNano / 1e6),
    end_time:       new Date(s.endTimeUnixNano / 1e6),
    attributes:     s.attributes,
    events:         s.events,
    links:          s.links,
    resource:       s.resource,
    scope:          s.scope,
  };
}

/**
 * SQL to create a table compatible with `defaultColumnMapper`. Run once
 * at setup time. Idempotent (`IF NOT EXISTS`).
 */
export function defaultSchemaSql(table = 'spans'): string {
  return `
    CREATE TABLE IF NOT EXISTS ${table} (
      span_id        TEXT PRIMARY KEY,
      trace_id       TEXT NOT NULL,
      parent_span_id TEXT,
      name           TEXT NOT NULL,
      kind           TEXT NOT NULL,
      status_code    TEXT NOT NULL DEFAULT 'UNSET',
      status_message TEXT,
      start_time     TIMESTAMPTZ NOT NULL,
      end_time       TIMESTAMPTZ,
      attributes     JSONB NOT NULL DEFAULT '{}'::jsonb,
      events         JSONB NOT NULL DEFAULT '[]'::jsonb,
      links          JSONB NOT NULL DEFAULT '[]'::jsonb,
      resource       JSONB NOT NULL DEFAULT '{}'::jsonb,
      scope          JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE INDEX IF NOT EXISTS ${table}_trace_idx        ON ${table}(trace_id);
    CREATE INDEX IF NOT EXISTS ${table}_parent_idx       ON ${table}(parent_span_id);
    CREATE INDEX IF NOT EXISTS ${table}_attributes_gin   ON ${table} USING gin(attributes);
  `;
}

// ---------------------------------------------------------------------------
// Sink
// ---------------------------------------------------------------------------

export function postgres(opts: PostgresSinkOptions): Sink {
  if (!opts.query && !opts.url) {
    throw new Error('[agent-otel/sinks/postgres] requires either `query` or `url`');
  }

  const table = opts.table ?? 'spans';
  const mapper = opts.columnMapper ?? defaultColumnMapper;
  const batchSize = opts.batchSize ?? 100;
  const flushIntervalMs = opts.flushIntervalMs ?? 5000;
  const conflictMode = opts.conflictMode ?? 'merge';
  const conflictKey = opts.conflictKey ?? 'span_id';

  let pending: Array<Record<string, unknown>> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let queryFn: PostgresQueryFn | null = opts.query ?? null;
  let pgConnection: any = null; // Cached `postgres` client when using `url`

  async function ensureQuery(): Promise<PostgresQueryFn> {
    if (queryFn) return queryFn;
    let mod: any;
    try {
      mod = await import('postgres');
    } catch {
      throw new Error(
        '[agent-otel/sinks/postgres] when using `url`, install the optional peer `postgres`. ' +
        'Or pass your own `query` function instead (works with any pg client).',
      );
    }
    const driver = mod.default ?? mod;
    pgConnection = driver(opts.url!);
    queryFn = async (sql: string, params: unknown[] = []) => {
      // The `postgres` package uses tagged-template syntax natively, but
      // also exposes `.unsafe(sql, params)` for parameterized strings.
      return await pgConnection.unsafe(sql, params);
    };
    return queryFn;
  }

  function buildInsertSql(rows: Array<Record<string, unknown>>): { sql: string; params: unknown[] } {
    if (rows.length === 0) return { sql: '', params: [] };

    // Use the FIRST row's keys as the canonical column list. All rows in a
    // batch must have the same shape (the mapper is deterministic per span,
    // and we don't mix column shapes within a batch). If a future row
    // adds a key, it'll go in the next batch instead.
    const cols = Object.keys(rows[0]!);
    const colList = cols.map(c => `"${c}"`).join(', ');

    const valueRows: string[] = [];
    const params: unknown[] = [];
    for (const row of rows) {
      const placeholders: string[] = [];
      for (const col of cols) {
        const value = row[col];
        // JSONB values: pass as JS object/array; the driver serializes to
        // text and the ::jsonb cast lets PG parse it as a JSON value (not
        // a JSON string scalar — the gotcha that ate two hours of my life).
        // The cast is also load-bearing on UPDATE re-firing of the merge:
        // without it, `||` would treat the parameter as text and concat
        // string-wise instead of merging objects.
        if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
          params.push(value);
          placeholders.push(`$${params.length}::jsonb`);
        } else {
          params.push(value ?? null);
          placeholders.push(`$${params.length}`);
        }
      }
      valueRows.push(`(${placeholders.join(', ')})`);
    }

    let conflictClause = '';
    if (conflictMode === 'ignore') {
      conflictClause = `ON CONFLICT ("${conflictKey}") DO NOTHING`;
    } else if (conflictMode === 'merge') {
      // For each non-key column: UPDATE with the new value, EXCEPT for jsonb
      // attribute-shaped columns where we MERGE (preserve keys not in the
      // new row). This composes safely with engine-side triggers that may
      // bootstrap rows with a partial column set.
      const updates = cols
        .filter(c => c !== conflictKey)
        .map(c => {
          // Heuristic: jsonb columns are merged via `||`; everything else
          // is overwritten. This matches Daslab's existing trigger pattern.
          if (c === 'attributes' || c === 'events' || c === 'links' || c === 'resource' || c === 'scope') {
            return `"${c}" = COALESCE(${table}."${c}", '{}'::jsonb) || EXCLUDED."${c}"`;
          }
          return `"${c}" = EXCLUDED."${c}"`;
        })
        .join(', ');
      conflictClause = `ON CONFLICT ("${conflictKey}") DO UPDATE SET ${updates}`;
    }

    const sql = `INSERT INTO "${table}" (${colList}) VALUES ${valueRows.join(', ')} ${conflictClause}`;
    return { sql, params };
  }

  async function send(rows: Array<Record<string, unknown>>) {
    if (rows.length === 0) return;
    const q = await ensureQuery();
    const { sql, params } = buildInsertSql(rows);
    await q(sql, params);
  }

  async function drain() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    await send(batch);
  }

  function scheduleFlush() {
    if (timer) return;
    timer = setTimeout(() => {
      drain().catch(err => console.error('[agent-otel/sinks/postgres] flush failed:', err));
    }, flushIntervalMs);
    if (typeof timer === 'object' && timer && 'unref' in timer) (timer as any).unref();
  }

  return {
    name: opts.name ?? 'postgres',
    async consume(span) {
      const row = mapper(span);
      if (row === null) return;
      pending.push(row);
      if (pending.length >= batchSize) {
        await drain();
      } else {
        scheduleFlush();
      }
    },
    async flush()    { await drain(); },
    async shutdown() {
      await drain();
      if (pgConnection?.end) {
        await pgConnection.end({ timeout: 5 });
      }
    },
  };
}
