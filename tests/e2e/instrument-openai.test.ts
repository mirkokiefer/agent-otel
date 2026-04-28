/**
 * E2E: agent-otel/openai auto-instrument against the real OpenAI API.
 *
 * Wraps a live OpenAI client, makes a real call, asserts an OTel span
 * landed in our router with the expected OpenInference attributes.
 *
 * Required env: OPENAI_API_KEY. Costs ~$0.0001 per run on gpt-5-nano
 * (cheapest GPT-5 variant — input $0.05/M, output $0.40/M).
 */

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';

import OpenAI from 'openai';
import { instrument } from '../../src/instrument/openai.js';
import { defineRouter } from '../../src/router.js';
import { memory } from '../../src/sinks/memory.js';
import { skipIfMissing } from './_helpers.js';

const apiKey = skipIfMissing('OPENAI_API_KEY');

const memSink = memory();
let sdk: NodeSDK | null = null;

beforeAll(async () => {
  if (!apiKey) return;

  const router = defineRouter({
    sinks: { mem: memSink },
    rules: [{ match: '*', to: ['mem'] }],
  });

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': 'agent-otel-instrument-openai-e2e',
    }),
    spanProcessors: [
      {
        onStart() {},
        onEnd(span) { void router.route(toRouted(span)); },
        async forceFlush() { await router.flush(); },
        async shutdown()   { await router.shutdown(); },
      } as any,
    ],
  });
  sdk.start();
});

afterAll(async () => {
  await sdk?.shutdown();
});

function toRouted(span: any): any {
  const startNs = span.startTime[0] * 1e9 + span.startTime[1];
  const endNs   = span.endTime[0]   * 1e9 + span.endTime[1];
  const KIND_NAMES = ['INTERNAL','SERVER','CLIENT','PRODUCER','CONSUMER'];
  const STATUS_NAMES = ['UNSET','OK','ERROR'];
  return {
    traceId: span.spanContext().traceId,
    spanId:  span.spanContext().spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    name: span.name,
    kind: KIND_NAMES[span.kind] ?? 'INTERNAL',
    status: { code: STATUS_NAMES[span.status.code] ?? 'UNSET', message: span.status.message },
    startTimeUnixNano: startNs,
    endTimeUnixNano: endNs,
    durationMs: (endNs - startNs) / 1e6,
    attributes: { ...(span.attributes ?? {}) },
    events: [],
    links:  [],
    resource: { ...(span.resource?.attributes ?? {}) },
    scope: { name: span.instrumentationScope.name, version: span.instrumentationScope.version },
  };
}

const TEST_MODEL = 'gpt-5-nano';

test('instrument(openai): real call emits OpenInference-shaped span', async () => {
  if (!apiKey) return;

  const client = instrument(new OpenAI({ apiKey: apiKey! }));

  const before = memSink.spans.length;
  const resp = await client.chat.completions.create({
    model: TEST_MODEL,
    max_completion_tokens: 50,
    messages: [
      { role: 'system', content: 'You are a strict echo machine.' },
      { role: 'user',   content: 'Reply with exactly the word "ping" — nothing else.' },
    ],
  } as any) as any;

  expect(resp).toBeDefined();
  expect(resp.choices?.[0]?.message).toBeDefined();

  const newSpans = memSink.spans.slice(before);
  expect(newSpans.length).toBeGreaterThanOrEqual(1);
  const span = newSpans[newSpans.length - 1]!;

  expect(span.name).toContain('chat openai');
  expect(span.name).toContain(TEST_MODEL);
  expect(span.kind).toBe('CLIENT');
  expect(span.status.code).toBe('OK');

  // OpenInference shape
  expect(span.attributes['openinference.span.kind']).toBe('LLM');
  expect(span.attributes['gen_ai.system']).toBe('openai');
  expect(span.attributes['llm.system']).toBe('openai');
  expect(span.attributes['llm.model_name']).toBe(TEST_MODEL);

  // Input messages flattened
  expect(span.attributes['llm.input_messages.0.message.role']).toBe('system');
  expect(span.attributes['llm.input_messages.1.message.role']).toBe('user');
  expect(typeof span.attributes['llm.input_messages.1.message.content']).toBe('string');

  // Output assistant message — content may be missing for reasoning models
  // that put effort into reasoning tokens; just verify role landed.
  expect(span.attributes['llm.output_messages.0.message.role']).toBe('assistant');

  // Token counts
  expect(span.attributes['llm.token_count.prompt']).toBeGreaterThan(0);
  expect(span.attributes['llm.token_count.completion']).toBeGreaterThan(0);
  expect(span.attributes['llm.token_count.total']).toBeGreaterThan(0);

  // Cost computed (gpt-5-nano is in the built-in table)
  expect(span.attributes['llm.cost.total']).toBeGreaterThan(0);

  // Replayable raw body
  expect(typeof span.attributes['llm.request.body']).toBe('string');
  expect((span.attributes['llm.request.body'] as string).length).toBeGreaterThan(20);

  // Response metadata
  expect(typeof span.attributes['llm.response.id']).toBe('string');
  expect(typeof span.attributes['llm.response.stop_reason']).toBe('string');
}, 30_000);

test('instrument(openai): tool call gets flattened to OpenInference shape', async () => {
  if (!apiKey) return;

  const client = instrument(new OpenAI({ apiKey: apiKey! }));

  const before = memSink.spans.length;
  await client.chat.completions.create({
    model: TEST_MODEL,
    max_completion_tokens: 100,
    messages: [{ role: 'user', content: 'What is the weather in San Francisco today?' }],
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get the current weather for a location',
        parameters: {
          type: 'object',
          properties: { location: { type: 'string' } },
          required: ['location'],
        },
      },
    }],
  } as any);

  const newSpans = memSink.spans.slice(before);
  const span = newSpans[newSpans.length - 1]!;

  // Tool definition flattened
  expect(span.attributes['llm.tools.count']).toBe(1);
  const schema = span.attributes['llm.tools.0.tool.json_schema'] as string;
  expect(schema).toContain('get_weather');
  expect(schema).toContain('location');

  // Model probably called the tool — assert if we got tool calls back
  const toolCallCount = span.attributes['llm.tool_calls.count'] as number | undefined;
  if (toolCallCount && toolCallCount > 0) {
    expect(span.attributes['llm.output_messages.0.message.tool_calls.0.tool_call.function.name']).toBe('get_weather');
    const args = span.attributes['llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments'] as string;
    expect(args).toContain('location');
  }
}, 30_000);

test('instrument(openai): error path sets ERROR status', async () => {
  if (!apiKey) return;
  const client = instrument(new OpenAI({ apiKey: apiKey! }));

  const before = memSink.spans.length;
  await expect(
    client.chat.completions.create({
      model: 'gpt-this-model-does-not-exist',
      max_completion_tokens: 20,
      messages: [{ role: 'user', content: 'hi' }],
    } as any),
  ).rejects.toThrow();

  const newSpans = memSink.spans.slice(before);
  const span = newSpans[newSpans.length - 1]!;
  expect(span.status.code).toBe('ERROR');
  expect(span.status.message).toBeTruthy();
}, 30_000);

test('instrument(openai): cost lookup matches dated model ids by prefix', async () => {
  // Pure unit-style assertion via instrument's lookup behavior. No API call.
  if (!apiKey) return;
  const client = instrument(new OpenAI({ apiKey: apiKey! }), {
    costPerToken: { 'gpt-5-nano': { input: 0.05 / 1_000_000, output: 0.4 / 1_000_000 } },
  });

  const before = memSink.spans.length;
  await client.chat.completions.create({
    model: 'gpt-5-nano-2025-08-07',         // dated id; should hit base via prefix match
    max_completion_tokens: 5,
    messages: [{ role: 'user', content: 'hi' }],
  } as any);

  const newSpans = memSink.spans.slice(before);
  const span = newSpans[newSpans.length - 1]!;
  expect(span.attributes['llm.cost.total']).toBeGreaterThan(0);
}, 30_000);
