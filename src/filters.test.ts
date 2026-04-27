/**
 * Quick smoke tests for the filter grammar.
 */

import { test, expect } from 'bun:test';
import { matches, and, or, not, substring, regex } from './filters.js';
import type { RoutedSpan } from './types.js';

const base: RoutedSpan = {
  traceId: 't', spanId: 's',
  name: 'demo',
  kind: 'CLIENT',
  status: { code: 'OK' },
  startTimeUnixNano: 0, endTimeUnixNano: 1, durationMs: 0,
  attributes: {},
  events: [], links: [],
  resource: {},
  scope: { name: 'test' },
};

test("'*' matches everything", () => {
  expect(matches(base, '*')).toBe(true);
});

test('attribute presence: { key: "*" }', () => {
  expect(matches({ ...base, attributes: { 'gen_ai.system': 'anthropic' } }, { 'gen_ai.system': '*' })).toBe(true);
  expect(matches(base, { 'gen_ai.system': '*' })).toBe(false);
});

test('attribute exact equality', () => {
  expect(matches({ ...base, attributes: { 'db.system': 'postgresql' } }, { 'db.system': 'postgresql' })).toBe(true);
  expect(matches({ ...base, attributes: { 'db.system': 'postgresql' } }, { 'db.system': 'mysql' })).toBe(false);
});

test('numeric comparisons', () => {
  const span = { ...base, attributes: { 'llm.cost.total': 0.42 } };
  expect(matches(span, { 'llm.cost.total': '>0.1' })).toBe(true);
  expect(matches(span, { 'llm.cost.total': '>0.5' })).toBe(false);
  expect(matches(span, { 'llm.cost.total': '<=0.42' })).toBe(true);
  expect(matches(span, { 'llm.cost.total': '>=0.42' })).toBe(true);
  expect(matches(span, { 'llm.cost.total': '<0.42' })).toBe(false);
});

test('top-level kind / status_code', () => {
  expect(matches(base, { kind: 'CLIENT' })).toBe(true);
  expect(matches(base, { kind: 'INTERNAL' })).toBe(false);
  expect(matches({ ...base, status: { code: 'ERROR', message: 'x' } }, { status_code: 'ERROR' })).toBe(true);
});

test('multiple keys are AND', () => {
  const span = { ...base, attributes: { 'gen_ai.system': 'anthropic', 'llm.cost.total': 0.5 } };
  expect(matches(span, { 'gen_ai.system': 'anthropic', 'llm.cost.total': '>0.1' })).toBe(true);
  expect(matches(span, { 'gen_ai.system': 'openai',     'llm.cost.total': '>0.1' })).toBe(false);
});

test('array of specs is OR', () => {
  const span = { ...base, attributes: { 'db.system': 'postgresql' } };
  expect(matches(span, [{ 'db.system': 'mysql' }, { 'db.system': 'postgresql' }])).toBe(true);
  expect(matches(span, [{ 'db.system': 'mysql' }, { 'db.system': 'sqlite' }])).toBe(false);
});

test('!= and == operators', () => {
  expect(matches({ ...base, attributes: { foo: 'bar' } }, { foo: '!=baz' })).toBe(true);
  expect(matches({ ...base, attributes: { foo: 'bar' } }, { foo: '!=bar' })).toBe(false);
  expect(matches({ ...base, attributes: { foo: 'bar' } }, { foo: '==bar' })).toBe(true);
});

// ---------------------------------------------------------------------------
// Combinators
// ---------------------------------------------------------------------------

test('and() requires every sub-spec', () => {
  const span = { ...base, attributes: { 'gen_ai.system': 'anthropic', 'llm.cost.total': 0.5 } };
  expect(matches(span, and({ 'gen_ai.system': 'anthropic' }, { 'llm.cost.total': '>0.1' }))).toBe(true);
  expect(matches(span, and({ 'gen_ai.system': 'anthropic' }, { 'llm.cost.total': '>0.9' }))).toBe(false);
});

test('or() succeeds on any sub-spec', () => {
  const span = { ...base, attributes: { 'db.system': 'postgresql' } };
  expect(matches(span, or({ 'db.system': 'mysql' }, { 'db.system': 'postgresql' }))).toBe(true);
  expect(matches(span, or({ 'db.system': 'mysql' }, { 'db.system': 'sqlite'    }))).toBe(false);
});

test('not() inverts', () => {
  const span = { ...base, attributes: { 'db.system': 'postgresql' } };
  expect(matches(span, not({ 'db.system': 'mysql'      }))).toBe(true);
  expect(matches(span, not({ 'db.system': 'postgresql' }))).toBe(false);
});

test('and(or, not) composes', () => {
  // (gen_ai.system in {anthropic, openai}) AND NOT (status_code = ERROR)
  const ok = { ...base, attributes: { 'gen_ai.system': 'anthropic' } };
  const err = { ...ok, status: { code: 'ERROR' as const, message: 'x' } };
  const otherProvider = { ...base, attributes: { 'gen_ai.system': 'cohere' } };

  const spec = and(
    or({ 'gen_ai.system': 'anthropic' }, { 'gen_ai.system': 'openai' }),
    not({ status_code: 'ERROR' }),
  );
  expect(matches(ok, spec)).toBe(true);
  expect(matches(err, spec)).toBe(false);
  expect(matches(otherProvider, spec)).toBe(false);
});

test('substring() on attribute', () => {
  const span = { ...base, attributes: { 'http.url': 'https://api.anthropic.com/v1/messages' } };
  expect(matches(span, substring('http.url', 'anthropic'))).toBe(true);
  expect(matches(span, substring('http.url', 'openai'))).toBe(false);
  expect(matches(span, substring('http.url', 'ANTHROPIC'))).toBe(false);
  expect(matches(span, substring('http.url', 'ANTHROPIC', true))).toBe(true);
});

test('substring() on top-level field (name)', () => {
  expect(matches({ ...base, name: 'chat anthropic' }, substring('name', 'anthropic'))).toBe(true);
  expect(matches({ ...base, name: 'chat anthropic' }, substring('name', 'openai'))).toBe(false);
});

test('regex() on attribute', () => {
  const span = { ...base, attributes: { 'http.url': 'https://api.anthropic.com/v1/messages' } };
  expect(matches(span, regex('http.url', /\.anthropic\./))).toBe(true);
  expect(matches(span, regex('http.url', '^https://'))).toBe(true);
  expect(matches(span, regex('http.url', '\\.openai\\.'))).toBe(false);
});

test('array form supports MatchOp entries', () => {
  // OR of plain spec + a MatchOp: matches if either branch matches
  const span = { ...base, name: 'chat openai' };
  expect(matches(span, [{ 'gen_ai.system': 'anthropic' }, substring('name', 'openai')])).toBe(true);
});

test('combinators handle missing keys gracefully', () => {
  // substring/regex on absent attribute → no match (not crash)
  expect(matches(base, substring('http.url', 'anything'))).toBe(false);
  expect(matches(base, regex('http.url', '.*'))).toBe(false);
  expect(matches(base, not({ 'absent.key': '*' }))).toBe(true);
});

// ---------------------------------------------------------------------------
// durationMs top-level field filters
// ---------------------------------------------------------------------------

test('durationMs: numeric range comparisons', () => {
  const slow = { ...base, durationMs: 1500 };
  const fast = { ...base, durationMs: 50 };

  expect(matches(slow, { durationMs: '>=1000' })).toBe(true);
  expect(matches(fast, { durationMs: '>=1000' })).toBe(false);
  expect(matches(slow, { durationMs: '<=2000' })).toBe(true);
  expect(matches(slow, { durationMs: '>1000'  })).toBe(true);
  expect(matches(slow, { durationMs: '<1000'  })).toBe(false);
  expect(matches(fast, { durationMs: '<1000'  })).toBe(true);
});

test('durationMs: combined with attribute filter via and()', () => {
  const span = { ...base, durationMs: 2000, attributes: { 'gen_ai.system': 'anthropic' } };
  expect(matches(span, and({ 'gen_ai.system': 'anthropic' }, { durationMs: '>=1000' }))).toBe(true);
  expect(matches(span, and({ 'gen_ai.system': 'anthropic' }, { durationMs: '>=3000' }))).toBe(false);
});

// ---------------------------------------------------------------------------
// Context attribute filters (session.id, user.id)
// ---------------------------------------------------------------------------

test('session.id attribute filter', () => {
  const span = { ...base, attributes: { 'session.id': 'scn_abc' } };
  expect(matches(span, { 'session.id': 'scn_abc' })).toBe(true);
  expect(matches(span, { 'session.id': 'scn_xyz' })).toBe(false);
  expect(matches(base, { 'session.id': '*' })).toBe(false);
});

test('user.id attribute filter', () => {
  const span = { ...base, attributes: { 'user.id': 'usr_123' } };
  expect(matches(span, { 'user.id': 'usr_123' })).toBe(true);
  expect(matches(base, { 'user.id': '*' })).toBe(false);
});

test('llm.cost.total range filter', () => {
  const span = { ...base, attributes: { 'llm.cost.total': 0.05 } };
  expect(matches(span, { 'llm.cost.total': '>=0.01' })).toBe(true);
  expect(matches(span, { 'llm.cost.total': '<=0.10' })).toBe(true);
  expect(matches(span, { 'llm.cost.total': '>=0.10' })).toBe(false);
});
