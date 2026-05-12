/**
 * E2E: postgres sink → real Postgres.
 *
 * Required env:
 *   POSTGRES_URL                postgres://... (any reachable Postgres)
 *
 * Optional env:
 *   POSTGRES_TEST_TABLE         override the temp table name (default: agent_otel_e2e_<random>)
 *
 * What we verify:
 *   - The sink creates+writes to a table matching the default OTel-canonical schema
 *   - Spans round-trip cleanly: SELECT after INSERT returns identical attributes
 *   - ON CONFLICT merge preserves prior attributes when the same span_id is
 *     written twice with different attribute keys (the engine-trigger compose case)
 *   - Cleans up the test table afterward
 */

import { test, expect } from 'bun:test';
import { postgres as postgresSink, defaultSchemaSql } from '../../src/sinks/postgres.js';
import { skipIfMissing, makeTestSpan, randomHex } from './_helpers.js';

const url = skipIfMissing('POSTGRES_URL');

test('postgres sink — round-trip and on-conflict merge', async () => {
  if (!url) return;

  const tableName = process.env.POSTGRES_TEST_TABLE ?? `agent_otel_e2e_${randomHex(8)}`;

  // Use the postgres package directly for setup/teardown queries.
  const { default: pgcc } = await import('postgres');
  const sql = pgcc(url!);

  try {
    // Create the table with the default schema
    await sql.unsafe(defaultSchemaSql(tableName));

    const sink = postgresSink({
      url: url!,
      table: tableName,
      batchSize: 10,
      flushIntervalMs: 1000,
    });

    // Phase 1: write three spans with distinct span_ids
    const spans = [
      makeTestSpan({ name: 'pg-e2e-1' }),
      makeTestSpan({ name: 'pg-e2e-2' }),
      makeTestSpan({ name: 'pg-e2e-3' }),
    ];
    for (const s of spans) await sink.consume(s);
    await sink.flush?.();

    const rows = await sql.unsafe(
      `SELECT span_id, name, kind, attributes FROM "${tableName}" ORDER BY name`
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((r: any) => r.name)).toEqual(['pg-e2e-1', 'pg-e2e-2', 'pg-e2e-3']);
    // postgres pkg returns JSONB as an object when round-tripped via the driver.
    const attrs0 = (rows[0] as any).attributes as Record<string, unknown>;
    expect(attrs0['gen_ai.system']).toBe('anthropic');

    // Phase 2: ON CONFLICT MERGE — write the same span_id again with a
    // DIFFERENT attribute. Original attributes should be preserved alongside
    // the new one. This is the "engine trigger writes first, sink updates
    // later" composability case.
    const original = spans[0]!;
    const update = makeTestSpan({
      ...original,
      attributes: { 'agent_otel.added_later': 'merged' },
    });
    await sink.consume(update);
    await sink.flush?.();
    await sink.shutdown?.();

    const merged = await sql.unsafe(
      `SELECT attributes FROM "${tableName}" WHERE span_id = $1`,
      [original.spanId],
    );
    const mergedAttrs = (merged[0] as any).attributes as Record<string, unknown>;
    expect(mergedAttrs['gen_ai.system']).toBe('anthropic');         // preserved from first write
    expect(mergedAttrs['agent_otel.added_later']).toBe('merged');   // from second write
  } finally {
    // Always clean up
    await sql.unsafe(`DROP TABLE IF EXISTS "${tableName}"`).catch(() => {});
    await sql.end({ timeout: 5 });
  }
}, 30_000);
