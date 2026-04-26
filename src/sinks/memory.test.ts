/**
 * Memory sink Inspectable surface — read-side primitives.
 *
 * Goal: prove that an in-process agent can query the ring buffer with
 * filter combinators and trace/span lookup, with auth-scope enforced via
 * `where`.
 */

import { test, expect } from 'bun:test';
import { memory } from './memory.js';
import { and, or, not, substring, regex } from '../filters.js';
import type { RoutedSpan } from '../types.js';

function span(p: Partial<RoutedSpan>): RoutedSpan {
  // Default span is at startTime 1_000_000_000_000_000_000 ns (~1970), bumped by id.
  const idHash = (p.spanId ?? 's').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const start = 1_000_000_000_000_000_000 + idHash * 1_000_000;
  return {
    traceId: 't1', spanId: 's',
    parentSpanId: undefined,
    name: 'demo',
    kind: 'INTERNAL',
    status: { code: 'OK' },
    startTimeUnixNano: start,
    endTimeUnixNano:   start + 1_000_000,   // 1ms duration
    durationMs: 1,
    attributes: {},
    events: [], links: [],
    resource: {},
    scope: { name: 'test' },
    ...p,
  };
}

test('findSpans: simple filter', () => {
  const sink = memory();
  sink.consume(span({ spanId: 'a', attributes: { 'gen_ai.system': 'anthropic' } }));
  sink.consume(span({ spanId: 'b', attributes: { 'gen_ai.system': 'openai'    } }));
  sink.consume(span({ spanId: 'c', attributes: { 'gen_ai.system': 'gemini'    } }));

  const hits = sink.findSpans({ 'gen_ai.system': 'anthropic' });
  expect(hits).toHaveLength(1);
  expect(hits[0]!.spanId).toBe('a');
});

test('findSpans: combinator (and/or/not)', () => {
  const sink = memory();
  sink.consume(span({ spanId: 'a', attributes: { 'gen_ai.system': 'anthropic', 'llm.cost.total': 0.5 } }));
  sink.consume(span({ spanId: 'b', attributes: { 'gen_ai.system': 'anthropic', 'llm.cost.total': 0.05 } }));
  sink.consume(span({ spanId: 'c', attributes: { 'gen_ai.system': 'openai',    'llm.cost.total': 0.5 } }));

  const expensiveAnthropic = sink.findSpans(
    and({ 'gen_ai.system': 'anthropic' }, { 'llm.cost.total': '>0.1' }),
  );
  expect(expensiveAnthropic.map(s => s.spanId).sort()).toEqual(['a']);

  const cheapOrOpenai = sink.findSpans(
    or({ 'llm.cost.total': '<0.1' }, { 'gen_ai.system': 'openai' }),
  );
  expect(cheapOrOpenai.map(s => s.spanId).sort()).toEqual(['b', 'c']);

  const notOpenai = sink.findSpans(not({ 'gen_ai.system': 'openai' }));
  expect(notOpenai.map(s => s.spanId).sort()).toEqual(['a', 'b']);
});

test('findSpans: substring + regex', () => {
  const sink = memory();
  sink.consume(span({ spanId: 'a', name: 'chat anthropic'  }));
  sink.consume(span({ spanId: 'b', name: 'chat openai'     }));
  sink.consume(span({ spanId: 'c', name: 'query postgres'  }));

  const chats = sink.findSpans(substring('name', 'chat'));
  expect(chats.map(s => s.spanId).sort()).toEqual(['a', 'b']);

  const httpish = sink.findSpans(regex('name', /^(chat|query)/));
  expect(httpish.map(s => s.spanId).sort()).toEqual(['a', 'b', 'c']);
});

test('findSpans: where (auth-scope) is non-bypassable', () => {
  const sink = memory();
  sink.consume(span({ spanId: 'a', attributes: { 'org.id': 'org_1', 'llm.cost.total': 0.5 } }));
  sink.consume(span({ spanId: 'b', attributes: { 'org.id': 'org_2', 'llm.cost.total': 0.5 } }));

  // Caller passes a permissive filter; embedder pins scope via `where`
  const scopedToOrg1 = sink.findSpans({ 'llm.cost.total': '>0.1' }, { where: { 'org.id': 'org_1' } });
  expect(scopedToOrg1.map(s => s.spanId)).toEqual(['a']);

  // Caller's filter cannot escape the scope, even with overlapping keys
  const escapeAttempt = sink.findSpans({ 'org.id': 'org_2' }, { where: { 'org.id': 'org_1' } });
  expect(escapeAttempt).toHaveLength(0);
});

test('findSpans: limit/offset/order', () => {
  const sink = memory();
  // Insert 5 spans with monotonically increasing start times
  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    sink.consume(span({ spanId: id }));
  }
  // Order is determined by spanId hash (see helper) — we just verify ordering is consistent
  const recent = sink.findSpans('*', { limit: 3, order: 'recent' });
  const oldest = sink.findSpans('*', { limit: 3, order: 'oldest' });
  expect(recent).toHaveLength(3);
  expect(oldest).toHaveLength(3);
  expect(recent[0]!.startTimeUnixNano).toBeGreaterThanOrEqual(recent[2]!.startTimeUnixNano);
  expect(oldest[0]!.startTimeUnixNano).toBeLessThanOrEqual(oldest[2]!.startTimeUnixNano);

  const page1 = sink.findSpans('*', { limit: 2, offset: 0, order: 'recent' });
  const page2 = sink.findSpans('*', { limit: 2, offset: 2, order: 'recent' });
  expect(page1.map(s => s.spanId)).not.toEqual(page2.map(s => s.spanId));
});

test('getSpan: by id, with optional where', () => {
  const sink = memory();
  sink.consume(span({ spanId: 'a', attributes: { 'org.id': 'org_1' } }));
  sink.consume(span({ spanId: 'b', attributes: { 'org.id': 'org_2' } }));

  expect(sink.getSpan('a')?.spanId).toBe('a');
  expect(sink.getSpan('missing')).toBeUndefined();

  // Auth scope: span 'a' belongs to org_1, scope says org_2 → not visible
  expect(sink.getSpan('a', { where: { 'org.id': 'org_2' } })).toBeUndefined();
  expect(sink.getSpan('a', { where: { 'org.id': 'org_1' } })?.spanId).toBe('a');
});

test('getTrace: returns siblings sorted by start_time', () => {
  const sink = memory();
  sink.consume(span({ traceId: 'tx', spanId: 'root',  parentSpanId: undefined }));
  sink.consume(span({ traceId: 'tx', spanId: 'child1', parentSpanId: 'root' }));
  sink.consume(span({ traceId: 'tx', spanId: 'child2', parentSpanId: 'root' }));
  sink.consume(span({ traceId: 'ty', spanId: 'other' })); // different trace

  const trace = sink.getTrace('tx');
  expect(trace).toHaveLength(3);
  expect(trace.map(s => s.spanId).sort()).toEqual(['child1', 'child2', 'root']);
  // start_time ASC
  for (let i = 1; i < trace.length; i++) {
    expect(trace[i]!.startTimeUnixNano).toBeGreaterThanOrEqual(trace[i - 1]!.startTimeUnixNano);
  }
});

test('stats: aggregates across filtered subset', () => {
  const sink = memory();
  sink.consume(span({ spanId: 'a', traceId: 't1', status: { code: 'OK'    }, attributes: { 'llm.cost.total': 0.10 } }));
  sink.consume(span({ spanId: 'b', traceId: 't1', status: { code: 'ERROR' }, attributes: { 'llm.cost.total': 0.05 } }));
  sink.consume(span({ spanId: 'c', traceId: 't2', status: { code: 'OK'    }, attributes: { 'llm.cost.total': 0.20 } }));

  const all = sink.stats();
  expect(all.spanCount).toBe(3);
  expect(all.traceCount).toBe(2);
  expect(all.errorCount).toBe(1);
  expect(all.totalCost).toBeCloseTo(0.35, 5);

  const errorsOnly = sink.stats({ status_code: 'ERROR' });
  expect(errorsOnly.spanCount).toBe(1);
  expect(errorsOnly.errorCount).toBe(1);
  expect(errorsOnly.totalCost).toBeCloseTo(0.05, 5);
});

test('clear() resets buffer and indexes', () => {
  const sink = memory();
  sink.consume(span({ spanId: 'a' }));
  sink.consume(span({ spanId: 'b' }));
  expect(sink.findSpans('*')).toHaveLength(2);
  expect(sink.getSpan('a')).toBeDefined();

  sink.clear();
  expect(sink.findSpans('*')).toHaveLength(0);
  expect(sink.getSpan('a')).toBeUndefined();
});

test('capacity eviction removes from indexes too', () => {
  const sink = memory({ capacity: 2 });
  sink.consume(span({ spanId: 'a' }));
  sink.consume(span({ spanId: 'b' }));
  sink.consume(span({ spanId: 'c' })); // evicts 'a'

  expect(sink.findSpans('*')).toHaveLength(2);
  expect(sink.getSpan('a')).toBeUndefined();   // index pruned
  expect(sink.getSpan('b')).toBeDefined();
  expect(sink.getSpan('c')).toBeDefined();
});
