import { describe, expect, test } from 'bun:test';
import type { Span } from '@opentelemetry/api';
import {
  setLLMFoundation,
  setLLMSampling,
  setLLMResponse,
} from './genai-attributes.js';

/** Minimal mock span that captures every setAttribute call as a map. */
function mockSpan(): Span & { attrs: Record<string, unknown> } {
  const attrs: Record<string, unknown> = {};
  const span = {
    attrs,
    setAttribute(key: string, value: unknown) { attrs[key] = value; return this; },
    setAttributes(map: Record<string, unknown>) { Object.assign(attrs, map); return this; },
    setStatus()      { return this; },
    updateName()     { return this; },
    end()            { /* noop */ },
    isRecording()    { return true; },
    recordException(){ return this; },
    addEvent()       { return this; },
    addLink()        { return this; },
    addLinks()       { return this; },
    spanContext()    { return { traceId: '', spanId: '', traceFlags: 0 }; },
  };
  return span as unknown as Span & { attrs: Record<string, unknown> };
}

describe('setLLMFoundation', () => {
  test('dup mode → emits both OpenInference and OTel-GenAI', () => {
    const span = mockSpan();
    setLLMFoundation(span, { provider: 'anthropic', model: 'claude-sonnet-4-7', serverAddress: 'api.anthropic.com' }, 'dup');
    expect(span.attrs['openinference.span.kind']).toBe('LLM');
    expect(span.attrs['llm.system']).toBe('anthropic');
    expect(span.attrs['llm.model_name']).toBe('claude-sonnet-4-7');
    expect(span.attrs['gen_ai.operation.name']).toBe('chat');
    expect(span.attrs['gen_ai.provider.name']).toBe('anthropic');
    expect(span.attrs['gen_ai.system']).toBe('anthropic');
    expect(span.attrs['gen_ai.request.model']).toBe('claude-sonnet-4-7');
    expect(span.attrs['server.address']).toBe('api.anthropic.com');
  });

  test('openinference mode → only OI attrs (no gen_ai.*)', () => {
    const span = mockSpan();
    setLLMFoundation(span, { provider: 'anthropic', model: 'claude-sonnet-4-7' }, 'openinference');
    expect(span.attrs['openinference.span.kind']).toBe('LLM');
    expect(span.attrs['llm.system']).toBe('anthropic');
    expect(span.attrs['gen_ai.operation.name']).toBeUndefined();
    expect(span.attrs['gen_ai.provider.name']).toBeUndefined();
    expect(span.attrs['gen_ai.request.model']).toBeUndefined();
  });

  test('gen_ai mode → only gen_ai.* (no llm.* / openinference.*)', () => {
    const span = mockSpan();
    setLLMFoundation(span, { provider: 'openai', model: 'gpt-5.5' }, 'gen_ai');
    expect(span.attrs['gen_ai.operation.name']).toBe('chat');
    expect(span.attrs['gen_ai.provider.name']).toBe('openai');
    expect(span.attrs['gen_ai.request.model']).toBe('gpt-5.5');
    expect(span.attrs['openinference.span.kind']).toBeUndefined();
    expect(span.attrs['llm.system']).toBeUndefined();
    expect(span.attrs['llm.model_name']).toBeUndefined();
  });

  test('server.address emits in all modes when set (stable attribute)', () => {
    for (const mode of ['openinference', 'dup', 'gen_ai'] as const) {
      const span = mockSpan();
      setLLMFoundation(span, { provider: 'x', model: 'y', serverAddress: 'host.example' }, mode);
      expect(span.attrs['server.address']).toBe('host.example');
    }
  });
});

describe('setLLMSampling', () => {
  test('dup mode → temperature in both name sets', () => {
    const span = mockSpan();
    setLLMSampling(span, { temperature: 0.7, max_tokens: 1024 }, 'dup');
    expect(span.attrs['llm.request.temperature']).toBe(0.7);
    expect(span.attrs['gen_ai.request.temperature']).toBe(0.7);
    expect(span.attrs['llm.request.max_tokens']).toBe(1024);
    expect(span.attrs['gen_ai.request.max_tokens']).toBe(1024);
  });

  test('OpenInference-only params (temperature, max_tokens) skip in gen_ai mode for llm.*', () => {
    const span = mockSpan();
    setLLMSampling(span, { temperature: 0.5, max_tokens: 200 }, 'gen_ai');
    expect(span.attrs['llm.request.temperature']).toBeUndefined();
    expect(span.attrs['gen_ai.request.temperature']).toBe(0.5);
    expect(span.attrs['llm.request.max_tokens']).toBeUndefined();
    expect(span.attrs['gen_ai.request.max_tokens']).toBe(200);
  });

  test('GenAI-only params (top_k, seed, stop_sequences) skip in openinference mode', () => {
    const span = mockSpan();
    setLLMSampling(span, { top_k: 40, seed: 42, stop_sequences: ['END'] }, 'openinference');
    expect(span.attrs['gen_ai.request.top_k']).toBeUndefined();
    expect(span.attrs['gen_ai.request.seed']).toBeUndefined();
    expect(span.attrs['gen_ai.request.stop_sequences']).toBeUndefined();
  });

  test('GenAI-only params emit in dup and gen_ai modes', () => {
    for (const mode of ['dup', 'gen_ai'] as const) {
      const span = mockSpan();
      setLLMSampling(span, { top_k: 40, seed: 42, stop_sequences: ['END'], stream: true }, mode);
      expect(span.attrs['gen_ai.request.top_k']).toBe(40);
      expect(span.attrs['gen_ai.request.seed']).toBe(42);
      expect(span.attrs['gen_ai.request.stop_sequences']).toEqual(['END']);
      expect(span.attrs['gen_ai.request.stream']).toBe(true);
    }
  });
});

describe('setLLMResponse', () => {
  test('dup mode → id + finish reason in both name sets', () => {
    const span = mockSpan();
    setLLMResponse(span, { id: 'msg_123', finishReasons: ['stop'] }, 'dup');
    expect(span.attrs['llm.response.id']).toBe('msg_123');
    expect(span.attrs['gen_ai.response.id']).toBe('msg_123');
    expect(span.attrs['llm.response.stop_reason']).toBe('stop');
    expect(span.attrs['gen_ai.response.finish_reasons']).toEqual(['stop']);
  });

  test('finish_reasons array preserved in gen_ai mode (plural)', () => {
    const span = mockSpan();
    setLLMResponse(span, { finishReasons: ['stop', 'length'] }, 'gen_ai');
    expect(span.attrs['gen_ai.response.finish_reasons']).toEqual(['stop', 'length']);
    expect(span.attrs['llm.response.stop_reason']).toBeUndefined();
  });

  test('gen_ai.response.model only in genai-emitting modes', () => {
    const dup = mockSpan();
    setLLMResponse(dup, { model: 'claude-sonnet-4-7-2026-04-23' }, 'dup');
    expect(dup.attrs['gen_ai.response.model']).toBe('claude-sonnet-4-7-2026-04-23');

    const oi = mockSpan();
    setLLMResponse(oi, { model: 'claude-sonnet-4-7-2026-04-23' }, 'openinference');
    expect(oi.attrs['gen_ai.response.model']).toBeUndefined();
  });

  test('time_to_first_chunk converts ms to seconds (spec wants seconds)', () => {
    const span = mockSpan();
    setLLMResponse(span, { timeToFirstChunkMs: 250 }, 'gen_ai');
    expect(span.attrs['gen_ai.response.time_to_first_chunk']).toBe(0.25);
  });
});
