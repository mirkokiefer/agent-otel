/**
 * E2E: counterfactual single-LLM replay against the real Anthropic API.
 *
 * The whole point of `replay-execute`: take a stored LLM span, swap one
 * thing (model, system prompt, etc.), call the real provider, get a real
 * response. Not data-mutation; ACTUAL re-execution.
 *
 * This test:
 *   1. Stores a synthetic LLM span containing a complete request body
 *      (OpenInference-shaped — what an instrumented Anthropic call emits).
 *   2. Calls `replayLLMCall` with `swapModel('claude-haiku-4-5')` —
 *      cheapest Anthropic model, ~$0.0001 per run.
 *   3. Asserts the new response has real content, real token counts,
 *      and matches the schema we documented.
 *
 * Required env:
 *   ANTHROPIC_API_KEY     real Anthropic key (costs ~$0.0001/run)
 *
 * Skipped if env not set.
 */

import { test, expect } from 'bun:test';
import { memory } from '../../src/sinks/memory.js';
import { replayLLMCall, swapModel, swapSystem, setTemperature, pipe } from '../../src/replay-execute.js';
import { skipIfMissing } from './_helpers.js';
import type { RoutedSpan } from '../../src/types.js';

const apiKey = skipIfMissing('ANTHROPIC_API_KEY');

/**
 * Synthesize a stored LLM span. OpenInference-shaped attributes:
 *   - llm.request.body: full JSON request (model, messages, system, …)
 *   - llm.model_name:   convenience top-level
 *   - flattened input messages for human-readable views
 */
function fixtureSpan(): RoutedSpan {
  const now = Date.now() * 1e6;
  const requestBody = JSON.stringify({
    model: 'claude-haiku-4-5',
    messages: [
      { role: 'user', content: 'Reply with the single word "alpha" — nothing else.' },
    ],
    system: 'You are a strict echo machine. Reply with exactly what the user asks for.',
    max_tokens: 20,
    temperature: 0,
  });

  return {
    traceId: '0000000000000000000000000000aaaa',
    spanId:  'aaaa000000000001',
    name: 'llm claude-haiku-4-5',
    kind: 'CLIENT',
    status: { code: 'OK' },
    startTimeUnixNano: now,
    endTimeUnixNano:   now + 1_000_000_000,
    durationMs: 1000,
    attributes: {
      'openinference.span.kind': 'LLM',
      'llm.model_name':          'claude-haiku-4-5',
      'llm.system':              'anthropic',
      'llm.request.body':        requestBody,
      'llm.request.body_bytes':  requestBody.length,
    },
    events: [], links: [],
    resource: { 'service.name': 'replay-execute-e2e' },
    scope: { name: 'agent-otel-e2e' },
  };
}

test('replayLLMCall: dryRun returns mutated request without calling provider', async () => {
  if (!apiKey) return;

  const sink = memory();
  sink.consume(fixtureSpan());

  const r = await replayLLMCall({
    source:  sink,
    spanId:  'aaaa000000000001',
    mutate:  swapModel('claude-opus-4-7'),
    dryRun:  true,
  });

  expect(r.originalRequest.model).toBe('claude-haiku-4-5');
  expect(r.mutatedRequest.model).toBe('claude-opus-4-7');
  expect(r.newResponse).toBeUndefined();
}, 10_000);

test('replayLLMCall: real Anthropic call returns content + tokens', async () => {
  if (!apiKey) return;

  const sink = memory();
  sink.consume(fixtureSpan());

  const r = await replayLLMCall({
    source:   sink,
    spanId:   'aaaa000000000001',
    mutate:   swapModel('claude-haiku-4-5'),  // cheap real call
    provider: 'anthropic',
    apiKey:   apiKey!,
  });

  // Round-trip basics
  expect(r.originalRequest.model).toBe('claude-haiku-4-5');
  expect(r.mutatedRequest.model).toBe('claude-haiku-4-5');
  expect(r.newResponse).toBeDefined();
  expect(r.durationMs).toBeGreaterThan(0);

  // Real content from Anthropic
  expect(typeof r.newResponse!.content).toBe('string');
  expect(r.newResponse!.content!.length).toBeGreaterThan(0);
  // Loose: prompt asked for "alpha" — most strict settings will produce it.
  // Don't fail on Anthropic randomness — just verify we got SOMETHING.

  // Real token counts
  expect(r.newResponse!.tokens).toBeDefined();
  expect(r.newResponse!.tokens!.input).toBeGreaterThan(0);
  expect(r.newResponse!.tokens!.output).toBeGreaterThan(0);
  expect(r.newResponse!.tokens!.total).toBe(
    (r.newResponse!.tokens!.input ?? 0) + (r.newResponse!.tokens!.output ?? 0),
  );
}, 30_000);

test('replayLLMCall: composed mutators (swapSystem + setTemperature)', async () => {
  if (!apiKey) return;

  const sink = memory();
  sink.consume(fixtureSpan());

  const r = await replayLLMCall({
    source:   sink,
    spanId:   'aaaa000000000001',
    mutate:   pipe(
      swapSystem('You are a poet. Reply in haiku.'),
      setTemperature(0.7),
    ),
    provider: 'anthropic',
    apiKey:   apiKey!,
  });

  // Mutator chain applied in order
  expect(r.mutatedRequest.system).toBe('You are a poet. Reply in haiku.');
  expect(r.mutatedRequest.temperature).toBe(0.7);
  // Original is untouched
  expect(r.originalRequest.system).toBe('You are a strict echo machine. Reply with exactly what the user asks for.');
  // And we got a real response
  expect(r.newResponse?.content?.length).toBeGreaterThan(0);
}, 30_000);

test('replayLLMCall: missing span throws', async () => {
  if (!apiKey) return;

  const sink = memory();
  await expect(replayLLMCall({
    source: sink,
    spanId: 'nonexistent',
    mutate: swapModel('claude-haiku-4-5'),
    dryRun: true,
  })).rejects.toThrow(/not found/);
}, 10_000);

test('replayLLMCall: missing apiKey for provider=anthropic throws', async () => {
  if (!apiKey) return;

  const sink = memory();
  sink.consume(fixtureSpan());
  await expect(replayLLMCall({
    source: sink,
    spanId: 'aaaa000000000001',
    mutate: swapModel('claude-haiku-4-5'),
    provider: 'anthropic',
    // no apiKey
  })).rejects.toThrow(/apiKey/);
}, 10_000);
