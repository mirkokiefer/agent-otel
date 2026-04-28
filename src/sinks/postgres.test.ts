/**
 * Unit tests for the postgres sink — focused on the MatchSpec → SQL compiler.
 *
 * We test by stubbing `query` with a recorder. No real Postgres needed.
 * E2E tests against an actual DB live in `tests/e2e/postgres.test.ts`.
 */

import { test, expect } from 'bun:test';
import { postgres as postgresSink } from './postgres.js';
import { and, or, not, substring, regex } from '../filters.js';

interface Capture { sql: string; params: unknown[]; }

function makeSink(rowsFor?: (sql: string, params: unknown[]) => unknown[]) {
  const calls: Capture[] = [];
  const sink = postgresSink({
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      return rowsFor ? rowsFor(sql, params) : [];
    },
    table: 'spans',
  });
  return { sink, calls };
}

test('findSpans: simple flat spec compiles to AND of attribute lookups', async () => {
  const { sink, calls } = makeSink();
  await sink.findSpans({ 'gen_ai.system': 'anthropic', 'llm.cost.total': '>0.1' });

  // Expect: SELECT FROM spans WHERE ((attributes->>'gen_ai.system') = $1) AND (((attributes->>'llm.cost.total'))::numeric > $2::numeric)
  // (Plus LIMIT/OFFSET parameters)
  const select = calls.find(c => c.sql.includes('SELECT'));
  expect(select).toBeDefined();
  expect(select!.sql).toContain('attributes->>');
  expect(select!.sql).toContain("'gen_ai.system'");
  expect(select!.sql).toContain("'llm.cost.total'");
  expect(select!.sql).toContain('::numeric');
  expect(select!.sql).toContain('LIMIT');
  expect(select!.sql).toContain('OFFSET');
  expect(select!.params).toEqual(['anthropic', 0.1, 100, 0]);
});

test('findSpans: top-level fields use columns, not attributes', async () => {
  const { sink, calls } = makeSink();
  await sink.findSpans({ kind: 'CLIENT', status_code: 'ERROR' });

  const select = calls.find(c => c.sql.includes('SELECT'))!;
  // Should reference column names, not attributes JSONB
  expect(select.sql).toMatch(/\bkind\b/);
  expect(select.sql).toMatch(/\bstatus_code\b/);
  // 'kind' / 'status_code' should NOT appear as attribute keys
  expect(select.sql).not.toContain("attributes->>'kind'");
  expect(select.sql).not.toContain("attributes->>'status_code'");
});

test('where AND-composes non-bypassably with caller filter', async () => {
  const { sink, calls } = makeSink();
  // Caller asks for org_2; embedder pins scope to org_1 — both keys overlap
  await sink.findSpans({ 'org.id': 'org_2' }, { where: { 'org.id': 'org_1' } });

  const select = calls.find(c => c.sql.includes('SELECT'))!;
  // Both values must be in params; neither dropped
  expect(select.params).toContain('org_1');
  expect(select.params).toContain('org_2');
  // SQL must AND both
  expect(select.sql).toMatch(/AND/);
});

test('and/or/not combinators compile correctly', async () => {
  const { sink, calls } = makeSink();
  await sink.findSpans(and(
    or({ 'gen_ai.system': 'anthropic' }, { 'gen_ai.system': 'openai' }),
    not({ status_code: 'ERROR' }),
  ));

  const select = calls.find(c => c.sql.includes('SELECT'))!;
  expect(select.sql).toContain(' OR ');
  expect(select.sql).toContain(' AND ');
  expect(select.sql).toContain('NOT');
  expect(select.params).toContain('anthropic');
  expect(select.params).toContain('openai');
  expect(select.params).toContain('ERROR');
});

test('substring → ILIKE/LIKE with escaped wildcards', async () => {
  const { sink, calls } = makeSink();
  await sink.findSpans(substring('http.url', 'anthropic.com'));

  const select = calls.find(c => c.sql.includes('SELECT'))!;
  expect(select.sql).toContain('LIKE');
  // Pattern wrapped in % … %
  expect(select.params).toContain('%anthropic.com%');
});

test('substring with ignoreCase uses ILIKE', async () => {
  const { sink, calls } = makeSink();
  await sink.findSpans(substring('name', 'CHAT', true));

  const select = calls.find(c => c.sql.includes('SELECT'))!;
  expect(select.sql).toContain('ILIKE');
});

test('regex → ~ operator (case-insensitive: ~*)', async () => {
  const cs = makeSink();
  await cs.sink.findSpans(regex('http.url', /anthropic/));
  expect(cs.calls.find(c => c.sql.includes('SELECT'))!.sql).toContain(' ~ ');

  const ci = makeSink();
  await ci.sink.findSpans(regex('http.url', /anthropic/i));
  expect(ci.calls.find(c => c.sql.includes('SELECT'))!.sql).toContain(' ~* ');
});

test("'*' presence check uses IS NOT NULL", async () => {
  const { sink, calls } = makeSink();
  await sink.findSpans({ 'gen_ai.system': '*' });

  const select = calls.find(c => c.sql.includes('SELECT'))!;
  expect(select.sql).toContain('IS NOT NULL');
});

test('getSpan: scopes via where', async () => {
  const { sink, calls } = makeSink();
  await sink.getSpan('span_xyz', { where: { 'org.id': 'org_1' } });

  const select = calls.find(c => c.sql.includes('SELECT'))!;
  expect(select.params).toEqual(['span_xyz', 'org_1']);
  expect(select.sql).toContain('span_id =');
  expect(select.sql).toMatch(/AND/);
});

test('getTrace: returns rows ordered by start_time ASC', async () => {
  const { sink, calls } = makeSink();
  await sink.getTrace('trace_abc');

  const select = calls.find(c => c.sql.includes('SELECT'))!;
  expect(select.sql).toContain('trace_id =');
  expect(select.sql).toContain('ORDER BY start_time ASC');
  expect(select.params[0]).toBe('trace_abc');
});

test('stats: aggregates with COUNT/AVG/SUM', async () => {
  const { sink, calls } = makeSink((sql) => {
    if (sql.includes('COUNT(*)')) {
      return [{
        span_count: 42, trace_count: 7, error_count: 3,
        avg_duration_ms: 123.4, total_cost: 0.99,
        earliest_start: '2026-04-27T10:00:00Z',
        latest_start:   '2026-04-27T11:00:00Z',
      }];
    }
    return [];
  });
  const stats = await sink.stats({ status_code: 'ERROR' });
  expect(stats.spanCount).toBe(42);
  expect(stats.traceCount).toBe(7);
  expect(stats.errorCount).toBe(3);
  expect(stats.avgDurationMs).toBeCloseTo(123.4, 5);
  expect(stats.totalCost).toBeCloseTo(0.99, 5);
  expect(stats.earliestStart).toBeTruthy();
  expect(stats.latestStart).toBeTruthy();

  const select = calls.find(c => c.sql.includes('COUNT(*)'))!;
  expect(select.sql).toContain('AVG');
  expect(select.sql).toContain('SUM');
});

test('rowToRoutedSpan round-trips a queried row', async () => {
  const { sink } = makeSink((sql) => {
    if (!sql.includes('SELECT')) return [];
    return [{
      span_id: 'sp_1', trace_id: 'tr_1',
      parent_span_id: 'sp_root',
      name: 'chat anthropic', kind: 'CLIENT',
      status_code: 'OK', status_message: null,
      start_time: new Date('2026-04-27T10:00:00Z'),
      end_time:   new Date('2026-04-27T10:00:01Z'),
      attributes: { 'gen_ai.system': 'anthropic', 'llm.cost.total': 0.1 },
      events: [], links: [], resource: { 'service.name': 'svc' },
      scope: { name: 'tracer', version: '1.0' },
    }];
  });
  const rows = await sink.findSpans('*');
  expect(rows).toHaveLength(1);
  const r = rows[0]!;
  expect(r.spanId).toBe('sp_1');
  expect(r.traceId).toBe('tr_1');
  expect(r.parentSpanId).toBe('sp_root');
  expect(r.name).toBe('chat anthropic');
  expect(r.kind).toBe('CLIENT');
  expect(r.status.code).toBe('OK');
  expect(r.attributes['gen_ai.system']).toBe('anthropic');
  expect(r.durationMs).toBe(1000);
});

test("duration_ms / durationMs filter: compiles to EXTRACT(EPOCH ...) on time columns", async () => {
  const cs = makeSink();
  await cs.sink.findSpans({ duration_ms: '>=1000' });
  const select = cs.calls.find(c => c.sql.includes('SELECT'))!;
  expect(select.sql).toContain('EXTRACT(EPOCH FROM (end_time - start_time))');
  // Numeric comparison
  expect(select.params).toContain(1000);

  const cc = makeSink();
  await cc.sink.findSpans({ durationMs: '<=500' });
  expect(cc.calls.find(c => c.sql.includes('SELECT'))!.sql)
    .toContain('EXTRACT(EPOCH FROM (end_time - start_time))');
});

test('attribute key with single quote is escaped', async () => {
  const { sink, calls } = makeSink();
  await sink.findSpans({ "weird'key": 'x' });
  const select = calls.find(c => c.sql.includes('SELECT'))!;
  expect(select.sql).toContain("weird''key");
});
