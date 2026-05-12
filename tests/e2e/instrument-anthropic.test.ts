/**
 * E2E: agent-otel/anthropic auto-instrument against the real Anthropic API.
 *
 * Wraps a live Anthropic client, makes a real call, asserts an OTel span
 * landed in our router with the expected OpenInference attributes:
 *   - gen_ai.system = 'anthropic'
 *   - llm.model_name set
 *   - llm.input_messages.* present
 *   - llm.token_count.{prompt,completion,total} populated
 *   - llm.cost.total computed
 *   - llm.request.body present (replayable)
 *   - openinference.span.kind = 'LLM'
 *
 * Required env: ANTHROPIC_API_KEY. Costs ~$0.0001 per run on Haiku.
 */

import { test, expect, beforeAll } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import { instrument } from '../../src/instrument/anthropic.js';
import { skipIfMissing } from './_helpers.js';
import { ensureOtel, sharedMemSink as memSink } from './_otel-setup.js';

const apiKey = skipIfMissing('ANTHROPIC_API_KEY');

beforeAll(() => { if (apiKey) ensureOtel(); });

test('instrument(anthropic): real call emits OpenInference-shaped span', async () => {
  if (!apiKey) return;

  const client = instrument(new Anthropic({ apiKey: apiKey! }));

  const before = memSink.spans.length;
  const resp = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 20,
    messages: [{ role: 'user', content: 'Reply with exactly the word "ping" — nothing else.' }],
    system: 'You are a strict echo machine.',
  } as any) as any;

  // Real response from Anthropic
  expect(resp).toBeDefined();
  expect(Array.isArray(resp.content)).toBe(true);

  // Span landed in our router
  const newSpans = memSink.spans.slice(before);
  expect(newSpans.length).toBeGreaterThanOrEqual(1);
  const span = newSpans[newSpans.length - 1]!;

  expect(span.name).toContain('chat anthropic');
  expect(span.name).toContain('claude-haiku-4-5');
  expect(span.kind).toBe('CLIENT');
  expect(span.status.code).toBe('OK');

  // OpenInference shape
  expect(span.attributes['openinference.span.kind']).toBe('LLM');
  expect(span.attributes['gen_ai.system']).toBe('anthropic');
  expect(span.attributes['llm.system']).toBe('anthropic');
  expect(span.attributes['llm.model_name']).toBe('claude-haiku-4-5');
  expect(span.attributes['gen_ai.request.model']).toBe('claude-haiku-4-5');

  // Input messages flattened
  expect(span.attributes['llm.input_messages.0.message.role']).toBeTruthy();   // system or user
  expect(span.attributes['llm.input_messages.1.message.role']).toBe('user');
  expect(typeof span.attributes['llm.input_messages.1.message.content']).toBe('string');

  // Output assistant message
  expect(span.attributes['llm.output_messages.0.message.role']).toBe('assistant');
  expect(typeof span.attributes['llm.output_messages.0.message.content']).toBe('string');

  // Token counts
  expect(span.attributes['llm.token_count.prompt']).toBeGreaterThan(0);
  expect(span.attributes['llm.token_count.completion']).toBeGreaterThan(0);
  expect(span.attributes['llm.token_count.total']).toBe(
    (span.attributes['llm.token_count.prompt'] as number) + (span.attributes['llm.token_count.completion'] as number),
  );

  // Cost computed (Haiku is in the built-in table)
  expect(span.attributes['llm.cost.total']).toBeGreaterThan(0);

  // Replayable raw body
  expect(typeof span.attributes['llm.request.body']).toBe('string');
  expect((span.attributes['llm.request.body'] as string).length).toBeGreaterThan(20);
}, 30_000);

test('instrument(anthropic): error path sets ERROR status + records exception', async () => {
  if (!apiKey) return;
  // Bad model name → Anthropic 400. Span should still land with ERROR.
  const client = instrument(new Anthropic({ apiKey: apiKey! }));

  const before = memSink.spans.length;
  await expect(
    client.messages.create({
      model: 'claude-this-model-does-not-exist',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'hi' }],
    } as any),
  ).rejects.toThrow();

  const newSpans = memSink.spans.slice(before);
  expect(newSpans.length).toBeGreaterThanOrEqual(1);
  const span = newSpans[newSpans.length - 1]!;
  expect(span.status.code).toBe('ERROR');
  expect(span.status.message).toBeTruthy();
}, 30_000);

test('instrument(anthropic): streaming pass-through does not break call', async () => {
  if (!apiKey) return;
  // v1: streaming bypasses instrumentation. Verify the call still works
  // (no span emitted is acceptable for now — but the Stream must work).
  const client = instrument(new Anthropic({ apiKey: apiKey! }));
  const stream = (await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'one word' }],
    stream: true,
  } as any)) as any;
  expect(stream).toBeDefined();
  // Exhaust stream so credits aren't held; we don't assert content.
  let chunks = 0;
  for await (const _ of stream) chunks++;
  expect(chunks).toBeGreaterThan(0);
}, 30_000);
