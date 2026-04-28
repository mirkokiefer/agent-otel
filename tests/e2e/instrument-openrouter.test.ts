/**
 * E2E: agent-otel/openrouter against the real OpenRouter API.
 *
 * Verifies the one-line client helper + instrument wrap by:
 *   - Calling a cheap model through OpenRouter
 *   - Asserting llm.system='openrouter' (overrides the OpenAI instrument's
 *     default 'openai') and llm.provider matches the model id prefix
 *
 * Required env: OPENROUTER_API_KEY. Costs ~$0.0001 on the free or cheap models.
 */

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';

import { client as openrouterClient, instrument as instrumentOR } from '../../src/instrument/openrouter.js';
import { defineRouter } from '../../src/router.js';
import { memory } from '../../src/sinks/memory.js';
import { skipIfMissing } from './_helpers.js';

const apiKey = skipIfMissing('OPENROUTER_API_KEY');

const memSink = memory();
let sdk: NodeSDK | null = null;

beforeAll(async () => {
  if (!apiKey) return;
  const router = defineRouter({
    sinks: { mem: memSink },
    rules: [{ match: '*', to: ['mem'] }],
  });
  sdk = new NodeSDK({
    resource: resourceFromAttributes({ 'service.name': 'agent-otel-instrument-openrouter-e2e' }),
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

afterAll(async () => { await sdk?.shutdown(); });

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

// OpenRouter has many cheap/free models. Use a known-good cheap one.
const TEST_MODEL = 'anthropic/claude-haiku-4-5';

test('openrouter client(): one-line setup → real call → tagged span', async () => {
  if (!apiKey) return;
  const c = await openrouterClient({ apiKey: apiKey!, appTitle: 'agent-otel-e2e' });

  const before = memSink.spans.length;
  const resp = await c.chat.completions.create({
    model: TEST_MODEL,
    max_completion_tokens: 30,
    messages: [{ role: 'user', content: 'Reply with the word "ok" only.' }],
  } as any) as any;

  expect(resp).toBeDefined();
  expect(Array.isArray(resp.choices)).toBe(true);

  const newSpans = memSink.spans.slice(before);
  expect(newSpans.length).toBeGreaterThanOrEqual(1);
  const span = newSpans[newSpans.length - 1]!;

  expect(span.kind).toBe('CLIENT');
  expect(span.status.code).toBe('OK');

  // OpenRouter-specific tagging (overrides openai default)
  expect(span.attributes['llm.system']).toBe('openrouter');
  expect(span.attributes['gen_ai.system']).toBe('openrouter');
  expect(span.attributes['llm.provider']).toBe('anthropic');     // from 'anthropic/...'
  expect(span.attributes['llm.openrouter.model']).toBe(TEST_MODEL);

  // OpenInference shape preserved from the underlying openai instrument
  expect(span.attributes['openinference.span.kind']).toBe('LLM');
  expect(span.attributes['llm.model_name']).toBe(TEST_MODEL);
  expect(span.attributes['llm.token_count.prompt']).toBeGreaterThan(0);
  expect(span.attributes['llm.token_count.completion']).toBeGreaterThan(0);
  expect(typeof span.attributes['llm.request.body']).toBe('string');
}, 30_000);

test('openrouter instrument() on a hand-built OpenAI client: same tagging', async () => {
  if (!apiKey) return;
  const OpenAI = (await import('openai')).default;
  const c = instrumentOR(new OpenAI({
    apiKey:  apiKey!,
    baseURL: 'https://openrouter.ai/api/v1',
  }) as any);

  const before = memSink.spans.length;
  await c.chat.completions.create({
    model: TEST_MODEL,
    max_completion_tokens: 20,
    messages: [{ role: 'user', content: 'reply with one word' }],
  } as any);

  const newSpans = memSink.spans.slice(before);
  const span = newSpans[newSpans.length - 1]!;
  expect(span.attributes['llm.system']).toBe('openrouter');
  expect(span.attributes['llm.provider']).toBe('anthropic');
}, 30_000);
