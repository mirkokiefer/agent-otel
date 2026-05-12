/**
 * Trace-tree tests. Synthetic spans only — pure data structure.
 */

import { test, expect } from 'bun:test';
import { buildTree, causalChain, descendants, siblings, firstError, renderTree } from './trace-tree.js';
import type { RoutedSpan } from './types.js';

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

// Build the typical agent trace shape:
//   root (AGENT)
//   ├─ chat (LLM)
//   │   └─ http (CLIENT)
//   └─ tool postgres (TOOL, ERROR)
function makeTrace(): RoutedSpan[] {
  return [
    span({ spanId: 'root',  name: 'job',  kind: 'INTERNAL' }),
    span({ spanId: 'chat',  name: 'chat anthropic', parentSpanId: 'root',  kind: 'CLIENT' }),
    span({ spanId: 'http',  name: 'http POST',      parentSpanId: 'chat',  kind: 'CLIENT' }),
    span({ spanId: 'tool',  name: 'query postgres', parentSpanId: 'root',  kind: 'CLIENT',
           status: { code: 'ERROR', message: 'timeout' } }),
  ];
}

test('buildTree: single root, children sorted by start_time', () => {
  const forest = buildTree(makeTrace());
  expect(forest.roots).toHaveLength(1);
  expect(forest.roots[0]!.span.spanId).toBe('root');
  expect(forest.roots[0]!.children.map(c => c.span.spanId)).toEqual(['chat', 'tool']);
  expect(forest.bySpanId.size).toBe(4);
});

test('buildTree: multiple roots when parents missing', () => {
  // Two orphans whose parents aren't in the input
  const spans = [
    span({ spanId: 'a', parentSpanId: 'missing1' }),
    span({ spanId: 'b', parentSpanId: 'missing2' }),
  ];
  const forest = buildTree(spans);
  expect(forest.roots).toHaveLength(2);
});

test('buildTree: parent backref is wired', () => {
  const forest = buildTree(makeTrace());
  const httpNode = forest.bySpanId.get('http')!;
  expect(httpNode.parent?.span.spanId).toBe('chat');
  expect(httpNode.parent?.parent?.span.spanId).toBe('root');
});

test('causalChain: root → target', () => {
  const forest = buildTree(makeTrace());
  const chain = causalChain(forest, 'http');
  expect(chain.map(s => s.spanId)).toEqual(['root', 'chat', 'http']);
});

test('causalChain: missing target → empty', () => {
  const forest = buildTree(makeTrace());
  expect(causalChain(forest, 'nonexistent')).toEqual([]);
});

test('descendants: collects all spans below a node', () => {
  const forest = buildTree(makeTrace());
  const root = forest.roots[0]!;
  const desc = descendants(root);
  expect(desc.map(s => s.spanId).sort()).toEqual(['chat', 'http', 'tool']);
});

test('descendants: with filter', () => {
  const forest = buildTree(makeTrace());
  const errors = descendants(forest.roots[0]!, { status_code: 'ERROR' });
  expect(errors.map(s => s.spanId)).toEqual(['tool']);
});

test('siblings: returns children of parent excluding self', () => {
  const forest = buildTree(makeTrace());
  const sibs = siblings(forest, 'chat');
  expect(sibs.map(s => s.spanId)).toEqual(['tool']);
});

test('siblings: root has no siblings', () => {
  const forest = buildTree(makeTrace());
  expect(siblings(forest, 'root')).toEqual([]);
});

test('firstError: finds the earliest ERROR by start time', () => {
  const forest = buildTree(makeTrace());
  expect(firstError(forest)?.spanId).toBe('tool');
});

test('renderTree: produces a readable ASCII tree', () => {
  const forest = buildTree(makeTrace());
  const out = renderTree(forest);
  expect(out).toContain('job');
  expect(out).toContain('chat anthropic');
  expect(out).toContain('├─');
  expect(out).toContain('└─');
  expect(out).toContain('ERROR');
});

test('renderTree: with maxDepth truncates and notes children count', () => {
  const forest = buildTree(makeTrace());
  const out = renderTree(forest, { maxDepth: 1 });
  expect(out).toContain('depth limit');
});

test('renderTree: inlineAttrs surfaces requested keys', () => {
  const trace = makeTrace();
  trace[1]!.attributes['llm.cost.total'] = 0.42;
  const forest = buildTree(trace);
  const out = renderTree(forest, { attrs: ['llm.cost.total'] });
  expect(out).toContain('llm.cost.total=0.42');
});
