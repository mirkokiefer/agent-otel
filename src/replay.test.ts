/**
 * Smoke test for replay: array source → router → memory sink.
 */

import { test, expect } from 'bun:test';
import { defineRouter } from './router.js';
import { memory } from './sinks/memory.js';
import { replay, fromArray } from './replay.js';
import type { RoutedSpan } from './types.js';

const mk = (overrides: Partial<RoutedSpan>): RoutedSpan => ({
  traceId: 't', spanId: 's', name: 'demo',
  kind: 'CLIENT', status: { code: 'OK' },
  startTimeUnixNano: 0, endTimeUnixNano: 1, durationMs: 0,
  attributes: {}, events: [], links: [],
  resource: {}, scope: { name: 'test' },
  ...overrides,
});

test('replay routes spans through a router', async () => {
  const sink = memory();
  const router = defineRouter({
    sinks: { mem: sink },
    rules: [{ match: '*', to: ['mem'] }],
  });

  const result = await replay({
    source: fromArray([
      mk({ spanId: 'a' }),
      mk({ spanId: 'b' }),
      mk({ spanId: 'c' }),
    ]),
    router,
  });

  expect(result.spansSeen).toBe(3);
  expect(result.spansRouted).toBe(3);
  expect(sink.spans).toHaveLength(3);
  expect(sink.spans.map(s => s.spanId)).toEqual(['a', 'b', 'c']);
});

test('replay where-filter skips non-matching spans', async () => {
  const sink = memory();
  const router = defineRouter({
    sinks: { mem: sink },
    rules: [{ match: '*', to: ['mem'] }],
  });

  await replay({
    source: fromArray([
      mk({ spanId: 'a', attributes: { kind_marker: 'keep' } }),
      mk({ spanId: 'b', attributes: { kind_marker: 'drop' } }),
      mk({ spanId: 'c', attributes: { kind_marker: 'keep' } }),
    ]),
    router,
    where: s => s.attributes.kind_marker === 'keep',
  });

  expect(sink.spans.map(s => s.spanId)).toEqual(['a', 'c']);
});

test('replay transform mutates spans before routing', async () => {
  const sink = memory();
  const router = defineRouter({
    sinks: { mem: sink },
    rules: [{ match: '*', to: ['mem'] }],
  });

  await replay({
    source: fromArray([mk({ spanId: 'a' })]),
    router,
    transform: s => ({
      ...s,
      attributes: { ...s.attributes, 'agent_otel.replay': true },
    }),
  });

  expect(sink.spans[0]?.attributes['agent_otel.replay']).toBe(true);
});

test('replay limit caps the number of routed spans', async () => {
  const sink = memory();
  const router = defineRouter({
    sinks: { mem: sink },
    rules: [{ match: '*', to: ['mem'] }],
  });

  await replay({
    source: fromArray(Array.from({ length: 100 }, (_, i) => mk({ spanId: `s${i}` }))),
    router,
    limit: 5,
  });

  expect(sink.spans).toHaveLength(5);
});
