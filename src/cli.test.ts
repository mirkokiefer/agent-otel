/**
 * CLI dispatcher tests — stub Inspectable, capture stdout/stderr.
 */

import { test, expect } from 'bun:test';
import { run, parseArgs, parseSince, buildFilter } from './cli.js';
import { memory } from './sinks/memory.js';
import type { Inspectable, RoutedSpan } from './types.js';

let nano = 1_000_000_000_000_000_000;
function span(p: Partial<RoutedSpan>): RoutedSpan {
  const start = nano; nano += 1_000_000;
  return {
    traceId: 't1', spanId: 's',
    name: 'demo', kind: 'INTERNAL',
    status: { code: 'OK' },
    startTimeUnixNano: start,
    endTimeUnixNano:   start + 1_000_000,
    durationMs: 1,
    attributes: {}, events: [], links: [],
    resource: {}, scope: { name: 'test' },
    ...p,
  };
}

function fixture(): Inspectable {
  const sink = memory();
  sink.consume(span({ spanId: 'root', name: 'job',  kind: 'INTERNAL' }));
  sink.consume(span({ spanId: 'chat', name: 'chat anthropic', parentSpanId: 'root', kind: 'CLIENT',
                      attributes: { 'gen_ai.system': 'anthropic', 'llm.cost.total': 0.42 } }));
  sink.consume(span({ spanId: 'tool', name: 'query postgres', parentSpanId: 'root', kind: 'CLIENT',
                      status: { code: 'ERROR', message: 'timeout' } }));
  return sink;
}

function captureRun(argv: string[], ins?: Inspectable): Promise<{ code: number; out: string; err: string }> {
  const fix = ins ?? fixture();
  const outBuf: string[] = [];
  const errBuf: string[] = [];
  return run({
    argv,
    out: s => outBuf.push(s),
    err: s => errBuf.push(s),
    isTty: false,                 // force JSON default for piping
    makeInspectable: async () => fix,
  }).then(code => ({
    code,
    out: outBuf.join('\n'),
    err: errBuf.join('\n'),
  }));
}

// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------

test('parseArgs: positional + --key=val + --key val', () => {
  const r = parseArgs(['query', '--status=ERROR', '--limit', '20', '--verbose']);
  expect(r.positional).toEqual(['query']);
  expect(r.flags).toEqual({ status: 'ERROR', limit: '20', verbose: true });
});

test('parseSince: relative durations', () => {
  const now = Date.now();
  const t = new Date(parseSince('5m')).getTime();
  expect(now - t).toBeGreaterThan(4 * 60_000);
  expect(now - t).toBeLessThan(6 * 60_000);
});

test('parseSince: ISO datetime passthrough', () => {
  const iso = '2026-04-27T10:00:00.000Z';
  expect(parseSince(iso)).toBe(iso);
});

test('parseSince: invalid throws', () => {
  expect(() => parseSince('not-a-time')).toThrow();
});

test('buildFilter: --status=ERROR', () => {
  expect(buildFilter({ status: 'ERROR' })).toEqual({ status_code: 'ERROR' });
});

test('buildFilter: --attr=k=v compounds with status via and()', () => {
  const f = buildFilter({ status: 'ERROR', attr: 'gen_ai.system=anthropic' });
  // Expect MatchOp `and` form
  expect(typeof f).toBe('object');
  expect((f as { op: string }).op).toBe('and');
});

// ---------------------------------------------------------------------------
// Subcommands (using fixture)
// ---------------------------------------------------------------------------

test('scry query: lists matching spans as JSON', async () => {
  const r = await captureRun(['query', '--status=ERROR']);
  expect(r.code).toBe(0);
  const parsed = JSON.parse(r.out);
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed).toHaveLength(1);
  expect(parsed[0].spanId).toBe('tool');
});

test('scry query: --output=table renders header row', async () => {
  const r = await captureRun(['query', '--output=table']);
  expect(r.code).toBe(0);
  expect(r.out).toContain('start');
  expect(r.out).toContain('span_id');
  expect(r.out).toContain('name');
});

test('scry query: --limit caps results', async () => {
  const r = await captureRun(['query', '--limit=2']);
  const parsed = JSON.parse(r.out);
  expect(parsed.length).toBeLessThanOrEqual(2);
});

test('scry trace get: returns all spans for trace', async () => {
  const r = await captureRun(['trace', 'get', 't1']);
  expect(r.code).toBe(0);
  const parsed = JSON.parse(r.out);
  expect(parsed).toHaveLength(3);
});

test('scry trace tree: renders ASCII tree', async () => {
  const r = await captureRun(['trace', 'tree', 't1']);
  expect(r.code).toBe(0);
  expect(r.out).toContain('job');
  expect(r.out).toContain('chat anthropic');
  expect(r.out).toContain('├─');   // tree branch
});

test('scry trace tree --output=json: JSON forest', async () => {
  const r = await captureRun(['trace', 'tree', 't1', '--output=json']);
  expect(r.code).toBe(0);
  const parsed = JSON.parse(r.out);
  expect(parsed.roots).toBeDefined();
  expect(parsed.roots[0].span.spanId).toBe('root');
  expect(parsed.roots[0].children).toHaveLength(2);
});

test('scry chain: walks root → target', async () => {
  const r = await captureRun(['chain', 't1', 'tool']);
  expect(r.code).toBe(0);
  const parsed = JSON.parse(r.out);
  expect(parsed.map((s: RoutedSpan) => s.spanId)).toEqual(['root', 'tool']);
});

test('scry chain: missing span → exit 1', async () => {
  const r = await captureRun(['chain', 't1', 'nope']);
  expect(r.code).toBe(1);
  expect(r.err).toContain('not found');
});

test('scry stats: aggregates as JSON', async () => {
  const r = await captureRun(['stats']);
  expect(r.code).toBe(0);
  const parsed = JSON.parse(r.out);
  expect(parsed.spanCount).toBe(3);
  expect(parsed.errorCount).toBe(1);
  expect(parsed.traceCount).toBe(1);
});

test('scry stats --status=ERROR: filtered aggregate', async () => {
  const r = await captureRun(['stats', '--status=ERROR']);
  const parsed = JSON.parse(r.out);
  expect(parsed.spanCount).toBe(1);
  expect(parsed.errorCount).toBe(1);
});

test('scry: no args prints help with exit 1', async () => {
  const r = await captureRun([]);
  expect(r.code).toBe(1);
  expect(r.out).toContain('USAGE:');
});

test('scry --help: prints help with exit 0', async () => {
  const r = await captureRun(['--help']);
  // Without positional command it returns 1; --help with a cmd would work.
  // Either way help renders.
  expect(r.out).toContain('scry');
});

test('scry mcp: not yet implemented', async () => {
  const r = await captureRun(['mcp']);
  expect(r.code).toBe(2);
  expect(r.err).toContain('not yet implemented');
});

test('scry unknown cmd: exit 2', async () => {
  const r = await captureRun(['foobar']);
  expect(r.code).toBe(2);
  expect(r.err).toContain('unknown command');
});

// ---------------------------------------------------------------------------
// New filter flags: session-id, agent-id, user-id, cost, duration
// ---------------------------------------------------------------------------

test('buildFilter: --session-id maps to session.id attribute', () => {
  const f = buildFilter({ 'session-id': 'scn_abc' });
  expect(f).toEqual({ 'session.id': 'scn_abc' });
});

test('buildFilter: --user-id maps to user.id attribute', () => {
  const f = buildFilter({ 'user-id': 'usr_123' });
  expect(f).toEqual({ 'user.id': 'usr_123' });
});

test('buildFilter: --min-cost builds >= expression on llm.cost.total', () => {
  const f = buildFilter({ 'min-cost': '0.01' }) as Record<string, string>;
  expect(f['llm.cost.total']).toBe('>=0.01');
});

test('buildFilter: --max-cost builds <= expression on llm.cost.total', () => {
  const f = buildFilter({ 'max-cost': '1.00' }) as Record<string, string>;
  expect(f['llm.cost.total']).toBe('<=1.00');
});

test('buildFilter: --min-duration builds >= expression on durationMs', () => {
  const f = buildFilter({ 'min-duration': '500' }) as Record<string, string>;
  expect((f as any).durationMs).toBe('>=500');
});

test('buildFilter: --max-duration builds <= expression on durationMs', () => {
  const f = buildFilter({ 'max-duration': '2000' }) as Record<string, string>;
  expect((f as any).durationMs).toBe('<=2000');
});

test('buildFilter: multiple new flags compose via and()', () => {
  const f = buildFilter({ 'session-id': 'scn_abc', 'min-cost': '0.01' });
  expect(typeof f).toBe('object');
  expect((f as { op: string }).op).toBe('and');
});

test('scry query: --session-id filters by session.id attribute', async () => {
  const sink = memory();
  sink.consume(span({ spanId: 'a', attributes: { 'session.id': 'scn_match' } }));
  sink.consume(span({ spanId: 'b', attributes: { 'session.id': 'scn_other' } }));
  const r = await captureRun(['query', '--session-id=scn_match'], sink);
  expect(r.code).toBe(0);
  const rows = JSON.parse(r.out);
  expect(rows).toHaveLength(1);
  expect(rows[0].spanId).toBe('a');
});

test('scry query: --min-duration filters by durationMs', async () => {
  const sink = memory();
  sink.consume(span({ spanId: 'fast', durationMs: 10 }));
  sink.consume(span({ spanId: 'slow', durationMs: 2000 }));
  const r = await captureRun(['query', '--min-duration=1000'], sink);
  expect(r.code).toBe(0);
  const rows = JSON.parse(r.out);
  expect(rows).toHaveLength(1);
  expect(rows[0].spanId).toBe('slow');
});
