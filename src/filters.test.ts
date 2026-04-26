/**
 * Quick smoke tests for the filter grammar.
 */

import { test, expect } from 'bun:test';
import { matches } from './filters.js';
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
