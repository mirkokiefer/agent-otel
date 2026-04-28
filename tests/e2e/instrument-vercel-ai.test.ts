/**
 * E2E: agent-otel/vercel-ai middleware against real Anthropic via @ai-sdk/anthropic.
 *
 * The whole point: drop tracingMiddleware() into wrapLanguageModel and your
 * generateText / streamText calls auto-emit OpenInference spans. Same
 * shape as the direct anthropic / openai instrument modules produce, so
 * dashboards stay uniform regardless of which path the agent author
 * picked.
 *
 * Required env: ANTHROPIC_API_KEY. Costs ~$0.0001 on Haiku.
 */

import { test, expect, beforeAll } from 'bun:test';
import { wrapLanguageModel, generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

import { tracingMiddleware } from '../../src/instrument/vercel-ai.js';
import { skipIfMissing } from './_helpers.js';
import { ensureOtel, sharedMemSink as memSink } from './_otel-setup.js';

const apiKey = skipIfMissing('ANTHROPIC_API_KEY');

beforeAll(() => { if (apiKey) ensureOtel(); });

test('vercel-ai middleware: real generateText emits OpenInference span', async () => {
  if (!apiKey) return;

  const model = wrapLanguageModel({
    model: anthropic('claude-haiku-4-5'),
    middleware: tracingMiddleware() as any,
  });

  const before = memSink.spans.length;
  const { text, usage, finishReason } = await generateText({
    model,
    prompt: 'Reply with the word "ok" only.',
    maxOutputTokens: 20,
  });

  expect(typeof text).toBe('string');
  expect(usage).toBeDefined();

  const newSpans = memSink.spans.slice(before);
  expect(newSpans.length).toBeGreaterThanOrEqual(1);
  const span = newSpans[newSpans.length - 1]!;

  // Span shape
  expect(span.name).toContain('chat anthropic');
  expect(span.name).toContain('claude-haiku-4-5');
  expect(span.kind).toBe('CLIENT');
  expect(span.status.code).toBe('OK');

  // OpenInference shape — same as anthropic/openai instrument modules
  expect(span.attributes['openinference.span.kind']).toBe('LLM');
  expect(span.attributes['gen_ai.system']).toBe('anthropic');
  expect(span.attributes['llm.system']).toBe('anthropic');
  expect(span.attributes['llm.provider']).toBe('anthropic');
  expect(span.attributes['llm.model_name']).toBe('claude-haiku-4-5');

  // Input prompt flattened
  expect(span.attributes['llm.input_messages.0.message.role']).toBe('user');
  expect(typeof span.attributes['llm.input_messages.0.message.content']).toBe('string');

  // Output assistant
  expect(span.attributes['llm.output_messages.0.message.role']).toBe('assistant');

  // Token counts
  expect(span.attributes['llm.token_count.prompt']).toBeGreaterThan(0);
  expect(span.attributes['llm.token_count.completion']).toBeGreaterThan(0);

  // Replayable raw body
  expect(typeof span.attributes['llm.request.body']).toBe('string');
  expect((span.attributes['llm.request.body'] as string).length).toBeGreaterThan(20);
}, 30_000);

test('vercel-ai middleware: error path sets ERROR status', async () => {
  if (!apiKey) return;

  const model = wrapLanguageModel({
    model: anthropic('claude-this-model-does-not-exist' as any),
    middleware: tracingMiddleware() as any,
  });

  const before = memSink.spans.length;
  await expect(
    generateText({ model, prompt: 'hi', maxOutputTokens: 10 }),
  ).rejects.toThrow();

  const newSpans = memSink.spans.slice(before);
  expect(newSpans.length).toBeGreaterThanOrEqual(1);
  const span = newSpans[newSpans.length - 1]!;
  expect(span.status.code).toBe('ERROR');
  expect(span.status.message).toBeTruthy();
}, 30_000);

test('vercel-ai middleware: cost computed when costPerToken provided', async () => {
  if (!apiKey) return;

  const model = wrapLanguageModel({
    model: anthropic('claude-haiku-4-5'),
    middleware: tracingMiddleware({
      costPerToken: {
        'anthropic:claude-haiku-4-5': { input: 1 / 1_000_000, output: 5 / 1_000_000 },
        'claude-haiku-4-5':           { input: 1 / 1_000_000, output: 5 / 1_000_000 },
      },
    }) as any,
  });

  const before = memSink.spans.length;
  await generateText({ model, prompt: 'one word', maxOutputTokens: 10 });

  const span = memSink.spans.slice(before).pop()!;
  expect(span.attributes['llm.cost.total']).toBeGreaterThan(0);
}, 30_000);
