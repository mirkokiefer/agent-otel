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
 *      triggers, this sink writes directly so you can
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
 * For non-default schemas (some engines add state columns
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
 * Or with a custom schema (e.g. an engine with extra state columns):
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
 *       // extra engine-state columns:
 *       exec_status: s.attributes.exec_status ?? 'completed',
 *       executor:    s.attributes.executor    ?? 'tool',
 *       cost:        s.attributes['llm.cost.total'],
 *     }),
 *   });
 */

import type {
  Inspectable,
  MatchOp,
  MatchSpec,
  QueryOptions,
  RoutedSpan,
  Sink,
  TraceStats,
} from '../types.js';
import { and as andMatch } from '../filters.js';

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
// MatchSpec → SQL compiler (used by Inspectable methods below)
// ---------------------------------------------------------------------------

/**
 * Top-level columns we treat specially. Anything else is interpreted as
 * an attribute key and compared against the JSONB `attributes` column.
 */
const SQL_TOP_LEVEL: Record<string, string> = {
  kind:        'kind',
  span_kind:   'kind',
  status_code: 'status_code',
  name:        'name',
};

interface SqlFrag {
  sql: string;
  params: unknown[];
}

/**
 * Compile a MatchSpec into a `(sql, params)` fragment suitable for inclusion
 * in a `WHERE`. Caller is responsible for the `WHERE` keyword.
 *
 * The `nextParam` ref lets us merge multiple compiled fragments into one
 * statement with continuous `$N` numbering.
 */
function compileMatch(spec: MatchSpec, nextParam: { n: number }): SqlFrag {
  if (spec === '*') return { sql: 'TRUE', params: [] };

  if (Array.isArray(spec)) {
    // Array form is OR
    const frags = spec.map(s => compileMatch(s as MatchSpec, nextParam));
    return {
      sql: '(' + frags.map(f => f.sql).join(' OR ') + ')',
      params: frags.flatMap(f => f.params),
    };
  }

  if (typeof spec === 'object' && 'op' in spec) {
    return compileOp(spec as MatchOp, nextParam);
  }

  // Flat object — AND of key/value comparisons
  const entries = Object.entries(spec);
  if (entries.length === 0) return { sql: 'TRUE', params: [] };

  const frags: SqlFrag[] = entries.map(([k, v]) => compileKeyValue(k, v, nextParam));
  return {
    sql: '(' + frags.map(f => f.sql).join(' AND ') + ')',
    params: frags.flatMap(f => f.params),
  };
}

function compileOp(op: MatchOp, nextParam: { n: number }): SqlFrag {
  switch (op.op) {
    case 'and': {
      if (op.specs.length === 0) return { sql: 'TRUE', params: [] };
      const frags = op.specs.map(s => compileMatch(s, nextParam));
      return { sql: '(' + frags.map(f => f.sql).join(' AND ') + ')', params: frags.flatMap(f => f.params) };
    }
    case 'or': {
      if (op.specs.length === 0) return { sql: 'FALSE', params: [] };
      const frags = op.specs.map(s => compileMatch(s, nextParam));
      return { sql: '(' + frags.map(f => f.sql).join(' OR ') + ')', params: frags.flatMap(f => f.params) };
    }
    case 'not': {
      const f = compileMatch(op.spec, nextParam);
      return { sql: `NOT ${f.sql}`, params: f.params };
    }
    case 'substring': {
      const lhs = sqlValueRef(op.key);
      const p = nextParam.n++;
      const rhs = `$${p}`;
      const operator = op.ignoreCase ? 'ILIKE' : 'LIKE';
      const value = `%${escapeLike(op.value)}%`;
      return { sql: `(${lhs} ${operator} ${rhs})`, params: [value] };
    }
    case 'regex': {
      const lhs = sqlValueRef(op.key);
      const p = nextParam.n++;
      const rhs = `$${p}`;
      // Postgres regex operators: `~` case-sensitive, `~*` case-insensitive.
      // We pass the JS pattern verbatim — most simple patterns work as-is in
      // POSIX regex; users with PCRE-only constructs will get a runtime error
      // from PG. Honest trade-off: keeping the lib light.
      const operator = op.flags?.includes('i') ? '~*' : '~';
      return { sql: `(${lhs} ${operator} ${rhs})`, params: [op.pattern] };
    }
  }
}

function compileKeyValue(
  key: string,
  expected: string | number | boolean,
  nextParam: { n: number },
): SqlFrag {
  // Special-case top-level columns
  if (SQL_TOP_LEVEL[key]) {
    return compileScalarComparison(SQL_TOP_LEVEL[key]!, expected, nextParam, /*column=*/true);
  }
  // Otherwise: attribute lookup. The JSONB `attributes` column stores values
  // as their natural JSON types; reading via `->>` always yields text.
  return compileScalarComparison(`(attributes->>${literalText(key)})`, expected, nextParam, false);
}

function compileScalarComparison(
  lhs: string,
  expected: string | number | boolean,
  nextParam: { n: number },
  isColumn: boolean,
): SqlFrag {
  // Presence check: '*'
  if (typeof expected === 'string' && expected === '*') {
    if (isColumn) return { sql: `${lhs} IS NOT NULL`, params: [] };
    // For attributes, presence = JSONB has the key. We don't know the JSON
    // path here without parsing — but the lhs already encodes `attributes->>'k'`,
    // so non-null after `->>` means the key exists with a non-null value.
    return { sql: `${lhs} IS NOT NULL`, params: [] };
  }

  if (typeof expected === 'number') {
    const p = nextParam.n++;
    return { sql: `((${lhs})::numeric = $${p}::numeric)`, params: [expected] };
  }
  if (typeof expected === 'boolean') {
    const p = nextParam.n++;
    return { sql: `((${lhs})::boolean = $${p}::boolean)`, params: [expected] };
  }

  // String expected
  const s = expected;
  if (s.startsWith('>=')) return numericCompare(lhs, '>=', s.slice(2), nextParam);
  if (s.startsWith('<=')) return numericCompare(lhs, '<=', s.slice(2), nextParam);
  if (s.startsWith('!=')) {
    const p = nextParam.n++;
    return { sql: `(${lhs} IS DISTINCT FROM $${p})`, params: [s.slice(2)] };
  }
  if (s.startsWith('==')) {
    const p = nextParam.n++;
    return { sql: `(${lhs} = $${p})`, params: [s.slice(2)] };
  }
  if (s.startsWith('>'))  return numericCompare(lhs, '>',  s.slice(1), nextParam);
  if (s.startsWith('<'))  return numericCompare(lhs, '<',  s.slice(1), nextParam);

  const p = nextParam.n++;
  return { sql: `(${lhs} = $${p})`, params: [s] };
}

function numericCompare(lhs: string, op: string, rhs: string, nextParam: { n: number }): SqlFrag {
  const p = nextParam.n++;
  return { sql: `((${lhs})::numeric ${op} $${p}::numeric)`, params: [Number(rhs)] };
}

function sqlValueRef(key: string): string {
  if (SQL_TOP_LEVEL[key]) return SQL_TOP_LEVEL[key]!;
  return `(attributes->>${literalText(key)})`;
}

function literalText(s: string): string {
  // Single-quoted SQL string literal with proper escaping. Used only for
  // attribute keys (controlled inputs from the caller's MatchSpec); never
  // for user data — that goes through parameters.
  return `'${s.replace(/'/g, "''")}'`;
}

function escapeLike(s: string): string {
  // Escape LIKE/ILIKE wildcards in user input.
  return s.replace(/[\\%_]/g, ch => '\\' + ch);
}

// ---------------------------------------------------------------------------
// Row → RoutedSpan
// ---------------------------------------------------------------------------

function rowToRoutedSpan(row: Record<string, unknown>): RoutedSpan {
  const startMs = (row.start_time instanceof Date)
    ? row.start_time.getTime()
    : Date.parse(String(row.start_time));
  const endMs   = row.end_time
    ? ((row.end_time instanceof Date) ? row.end_time.getTime() : Date.parse(String(row.end_time)))
    : startMs;
  return {
    traceId: String(row.trace_id),
    spanId:  String(row.span_id),
    parentSpanId: row.parent_span_id ? String(row.parent_span_id) : undefined,
    name: String(row.name),
    kind: (row.kind as RoutedSpan['kind']) ?? 'INTERNAL',
    status: {
      code:    (row.status_code as RoutedSpan['status']['code']) ?? 'UNSET',
      message: row.status_message ? String(row.status_message) : undefined,
    },
    startTimeUnixNano: startMs * 1e6,
    endTimeUnixNano:   endMs   * 1e6,
    durationMs: endMs - startMs,
    attributes: (row.attributes as RoutedSpan['attributes']) ?? {},
    events:     (row.events     as RoutedSpan['events'])     ?? [],
    links:      (row.links      as RoutedSpan['links'])      ?? [],
    resource:   (row.resource   as RoutedSpan['resource'])   ?? {},
    scope:      (row.scope      as RoutedSpan['scope'])      ?? { name: '' },
  };
}

const SELECT_COLS = `
  span_id, trace_id, parent_span_id, name, kind,
  status_code, status_message, start_time, end_time,
  attributes, events, links, resource, scope
`;

// ---------------------------------------------------------------------------
// Sink
// ---------------------------------------------------------------------------

export function postgres(opts: PostgresSinkOptions): Sink & Inspectable {
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
          // is overwritten. This matches the typical engine-trigger pattern.
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

  // ---- Inspectable helpers ----

  function compose(filter: MatchSpec, where?: MatchSpec): MatchSpec {
    return where ? andMatch(filter, where) : filter;
  }

  async function runRows(sql: string, params: unknown[]): Promise<RoutedSpan[]> {
    const q = await ensureQuery();
    const result = await q(sql, params);
    // `postgres` package returns an array-like; `pg` returns { rows }.
    const rows: Array<Record<string, unknown>> = Array.isArray(result)
      ? (result as Array<Record<string, unknown>>)
      : ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []);
    return rows.map(rowToRoutedSpan);
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

    // ---- Inspectable ----

    async findSpans(filter, queryOpts) {
      // Flush so the query sees writes from this process.
      await drain();
      const next = { n: 1 };
      const where = compileMatch(compose(filter, queryOpts?.where), next);
      const order = queryOpts?.order === 'oldest' ? 'ASC' : 'DESC';
      const limit  = queryOpts?.limit  ?? 100;
      const offset = queryOpts?.offset ?? 0;
      const limitP  = next.n++;
      const offsetP = next.n++;
      const sql = `
        SELECT ${SELECT_COLS}
          FROM "${table}"
         WHERE ${where.sql}
         ORDER BY start_time ${order}
         LIMIT $${limitP} OFFSET $${offsetP}
      `;
      return runRows(sql, [...where.params, limit, offset]);
    },

    async getSpan(spanId, queryOpts) {
      await drain();
      const next = { n: 1 };
      const idParam = next.n++;
      let sql = `SELECT ${SELECT_COLS} FROM "${table}" WHERE span_id = $${idParam}`;
      const params: unknown[] = [spanId];
      if (queryOpts?.where) {
        const where = compileMatch(queryOpts.where, next);
        sql += ` AND ${where.sql}`;
        params.push(...where.params);
      }
      sql += ' LIMIT 1';
      const rows = await runRows(sql, params);
      return rows[0];
    },

    async getTrace(traceId, queryOpts) {
      await drain();
      const next = { n: 1 };
      const idParam = next.n++;
      let sql = `SELECT ${SELECT_COLS} FROM "${table}" WHERE trace_id = $${idParam}`;
      const params: unknown[] = [traceId];
      if (queryOpts?.where) {
        const where = compileMatch(queryOpts.where, next);
        sql += ` AND ${where.sql}`;
        params.push(...where.params);
      }
      sql += ' ORDER BY start_time ASC';
      return runRows(sql, params);
    },

    async stats(filter, queryOpts) {
      await drain();
      const composed: MatchSpec | undefined = filter
        ? compose(filter, queryOpts?.where)
        : (queryOpts?.where ?? undefined);
      const next = { n: 1 };
      const whereSql = composed
        ? compileMatch(composed, next)
        : { sql: 'TRUE', params: [] as unknown[] };
      const sql = `
        SELECT
          COUNT(*)::int                                                                        AS span_count,
          COUNT(DISTINCT trace_id)::int                                                        AS trace_count,
          COUNT(*) FILTER (WHERE status_code = 'ERROR')::int                                   AS error_count,
          AVG(EXTRACT(EPOCH FROM (end_time - start_time)) * 1000)::float                       AS avg_duration_ms,
          SUM(NULLIF(attributes->>'llm.cost.total','')::numeric)::float                        AS total_cost,
          MIN(start_time) AS earliest_start,
          MAX(start_time) AS latest_start
        FROM "${table}"
        WHERE ${whereSql.sql}
      `;
      const q = await ensureQuery();
      const result = await q(sql, whereSql.params);
      const rows: Array<Record<string, unknown>> = Array.isArray(result)
        ? (result as Array<Record<string, unknown>>)
        : ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []);
      const r = rows[0] ?? {};
      const toIso = (v: unknown): string | null => {
        if (!v) return null;
        if (v instanceof Date) return v.toISOString();
        return new Date(String(v)).toISOString();
      };
      return {
        spanCount:    Number(r.span_count    ?? 0),
        traceCount:   Number(r.trace_count   ?? 0),
        errorCount:   Number(r.error_count   ?? 0),
        avgDurationMs: r.avg_duration_ms != null ? Number(r.avg_duration_ms) : null,
        totalCost:     r.total_cost      != null ? Number(r.total_cost)      : null,
        earliestStart: toIso(r.earliest_start),
        latestStart:   toIso(r.latest_start),
      } satisfies TraceStats;
    },
  };
}
