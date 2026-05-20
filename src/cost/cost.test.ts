import { describe, expect, test } from 'bun:test';
import { calculateCost } from './calculate.js';
import { openai, anthropic, gemini } from './extractors/index.js';
import { recordLLMCall } from './record.js';
import {
  GEN_AI_COST_TOTAL, GEN_AI_COST_INPUT, GEN_AI_COST_OUTPUT,
  GEN_AI_COST_CACHE_READ, GEN_AI_COST_CACHE_WRITE, GEN_AI_COST_TYPE,
  GEN_AI_USAGE_INPUT_TOKENS, GEN_AI_USAGE_OUTPUT_TOKENS,
  LLM_COST_TOTAL, LLM_TOKEN_COUNT_PROMPT, LLM_TOKEN_COUNT_TOTAL,
  LLM_TOKEN_COUNT_PROMPT_CACHE_READ,
} from './attrs.js';
import type { ModelPricing, PricingSource } from './types.js';

// Tiny in-memory pricing source for tests. Real users wire their own.
function staticPricing(table: Record<string, ModelPricing>): PricingSource {
  return { lookup: (m) => table[m] };
}

describe('calculateCost', () => {
  const pricing = staticPricing({
    'claude-sonnet':     { input: 3, output: 15 }, // USD per 1M
    'gpt-cached':        { input: 1, output: 4, cache_read_multiplier: 0.5 },
    'reasoning-distinct': { input: 2, output: 8, reasoning: 32 },
  });

  test('actual provider_cost wins over estimate', () => {
    const r = calculateCost('any-model', {
      input_tokens: 100, output_tokens: 50, provider_cost: 0.0042,
    }, pricing);
    expect(r.costType).toBe('actual');
    expect(r.cost).toBe(0.0042);
    expect(r.breakdown).toBeUndefined();
  });

  test('provider_cost = 0 is treated as "not reported" (estimate falls through)', () => {
    const r = calculateCost('claude-sonnet', {
      input_tokens: 1_000_000, output_tokens: 0, provider_cost: 0,
    }, pricing);
    expect(r.costType).toBe('estimated');
    expect(r.cost).toBeCloseTo(3, 8);
  });

  test('unknown model → cost 0, costType unknown', () => {
    const r = calculateCost('no-such-model', {
      input_tokens: 100, output_tokens: 50,
    }, pricing);
    expect(r).toEqual({ cost: 0, costType: 'unknown' });
  });

  test('estimate from table — input + output only', () => {
    const r = calculateCost('claude-sonnet', {
      input_tokens: 1_000_000, output_tokens: 1_000_000,
    }, pricing);
    // input = 3, output = 15
    expect(r.cost).toBeCloseTo(18, 8);
    expect(r.costType).toBe('estimated');
    expect(r.breakdown?.input).toBeCloseTo(3, 8);
    expect(r.breakdown?.output).toBeCloseTo(15, 8);
    expect(r.breakdown?.cache_read).toBeUndefined();
  });

  test('cache_read uses pricing.cache_read_multiplier (default 0.1)', () => {
    const r = calculateCost('claude-sonnet', {
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 1_000_000,
    }, pricing);
    // 1M tokens × $3/M × 0.1 = $0.30
    expect(r.cost).toBeCloseTo(0.3, 8);
    expect(r.breakdown?.cache_read).toBeCloseTo(0.3, 8);
  });

  test('cache_read uses per-model override when set', () => {
    const r = calculateCost('gpt-cached', {
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 1_000_000,
    }, pricing);
    // 1M × $1/M × 0.5 = $0.50
    expect(r.cost).toBeCloseTo(0.5, 8);
  });

  test('cache_creation uses default 1.25 multiplier', () => {
    const r = calculateCost('claude-sonnet', {
      input_tokens: 0, output_tokens: 0, cache_creation_tokens: 1_000_000,
    }, pricing);
    // 1M × $3/M × 1.25 = $3.75
    expect(r.cost).toBeCloseTo(3.75, 8);
    expect(r.breakdown?.cache_creation).toBeCloseTo(3.75, 8);
  });

  test('reasoning defaults to output rate', () => {
    const r = calculateCost('claude-sonnet', {
      input_tokens: 0, output_tokens: 0, reasoning_tokens: 1_000_000,
    }, pricing);
    // defaults to $15/M (claude-sonnet.output)
    expect(r.cost).toBeCloseTo(15, 8);
    expect(r.breakdown?.reasoning).toBeCloseTo(15, 8);
  });

  test('reasoning uses explicit pricing.reasoning when present', () => {
    const r = calculateCost('reasoning-distinct', {
      input_tokens: 0, output_tokens: 0, reasoning_tokens: 1_000_000,
    }, pricing);
    expect(r.cost).toBeCloseTo(32, 8);
  });

  test('mixed buckets sum correctly', () => {
    const r = calculateCost('claude-sonnet', {
      input_tokens:           1_000_000,  //   3.00
      output_tokens:            500_000,  //   7.50
      cache_read_tokens:      2_000_000,  //   0.60  (2M × 3 × 0.1)
      cache_creation_tokens:    100_000,  //   0.375 (0.1M × 3 × 1.25)
      reasoning_tokens:         200_000,  //   3.00  (0.2M × 15 default)
    }, pricing);
    // total = 3 + 7.5 + 0.6 + 0.375 + 3 = 14.475
    expect(r.cost).toBeCloseTo(14.475, 6);
  });
});

describe('extractors.openai', () => {
  test('subtracts cached_tokens from prompt_tokens to get uncached input', () => {
    const u = openai({
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 800 },
    });
    expect(u.input_tokens).toBe(200);      // gross 1000 - 800 cached
    expect(u.cache_read_tokens).toBe(800);
    expect(u.output_tokens).toBe(50);
  });

  test('no cache → no cache_read_tokens field set', () => {
    const u = openai({ prompt_tokens: 100, completion_tokens: 20 });
    expect(u.input_tokens).toBe(100);
    expect(u.cache_read_tokens).toBeUndefined();
  });

  test('OpenRouter cost field carries through as provider_cost', () => {
    const u = openai({
      prompt_tokens: 50, completion_tokens: 25, cost: 0.0012,
    });
    expect(u.provider_cost).toBe(0.0012);
  });

  test('reasoning tokens carry through', () => {
    const u = openai({
      prompt_tokens: 100, completion_tokens: 200,
      completion_tokens_details: { reasoning_tokens: 150 },
    });
    expect(u.reasoning_tokens).toBe(150);
  });

  test('null/undefined input → zeroed but well-formed usage', () => {
    expect(openai(undefined)).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(openai(null)).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  test('subtraction floors at 0 when provider gives weird numbers', () => {
    const u = openai({
      prompt_tokens: 50, completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: 100 }, // > prompt_tokens (weird)
    });
    expect(u.input_tokens).toBe(0);
  });
});

describe('extractors.anthropic', () => {
  test('input_tokens is already uncached — no subtraction', () => {
    const u = anthropic({
      input_tokens: 200,
      output_tokens: 50,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 100,
    });
    expect(u.input_tokens).toBe(200);            // not subtracted
    expect(u.cache_read_tokens).toBe(800);
    expect(u.cache_creation_tokens).toBe(100);
    expect(u.output_tokens).toBe(50);
  });

  test('missing cache fields → undefined', () => {
    const u = anthropic({ input_tokens: 50, output_tokens: 20 });
    expect(u.cache_read_tokens).toBeUndefined();
    expect(u.cache_creation_tokens).toBeUndefined();
  });
});

describe('extractors.gemini', () => {
  test('subtracts cachedContentTokenCount from promptTokenCount', () => {
    const u = gemini({
      promptTokenCount: 1000,
      candidatesTokenCount: 200,
      cachedContentTokenCount: 600,
      thoughtsTokenCount: 50,
    });
    expect(u.input_tokens).toBe(400);
    expect(u.cache_read_tokens).toBe(600);
    expect(u.output_tokens).toBe(200);
    expect(u.reasoning_tokens).toBe(50);
  });
});

describe('recordLLMCall', () => {
  // Minimal mock Span — captures setAttribute calls.
  function makeSpan() {
    const attrs: Record<string, unknown> = {};
    return {
      attrs,
      setAttribute(key: string, value: unknown) { attrs[key] = value; return this; },
    } as any;
  }

  test('writes both OTel-GenAI and OpenInference token attrs', () => {
    const span = makeSpan();
    recordLLMCall(span, { usage: { input_tokens: 100, output_tokens: 50 } });
    expect(span.attrs[GEN_AI_USAGE_INPUT_TOKENS]).toBe(100);
    expect(span.attrs[GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(50);
    expect(span.attrs[LLM_TOKEN_COUNT_PROMPT]).toBe(100);
    expect(span.attrs[LLM_TOKEN_COUNT_TOTAL]).toBe(150);
  });

  test('writes cache_read attr only when set + > 0', () => {
    const s1 = makeSpan();
    recordLLMCall(s1, { usage: { input_tokens: 10, output_tokens: 5 } });
    expect(s1.attrs[LLM_TOKEN_COUNT_PROMPT_CACHE_READ]).toBeUndefined();

    const s2 = makeSpan();
    recordLLMCall(s2, { usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 800 } });
    expect(s2.attrs[LLM_TOKEN_COUNT_PROMPT_CACHE_READ]).toBe(800);
  });

  test('dual-writes cost attrs when cost provided', () => {
    const span = makeSpan();
    recordLLMCall(span, {
      usage: { input_tokens: 1000, output_tokens: 500 },
      cost: {
        cost: 0.0042,
        costType: 'estimated',
        breakdown: { input: 0.003, output: 0.0012 },
      },
    });
    expect(span.attrs[GEN_AI_COST_TOTAL]).toBe(0.0042);
    expect(span.attrs[LLM_COST_TOTAL]).toBe(0.0042);
    expect(span.attrs[GEN_AI_COST_TYPE]).toBe('estimated');
    expect(span.attrs[GEN_AI_COST_INPUT]).toBe(0.003);
    expect(span.attrs[GEN_AI_COST_OUTPUT]).toBe(0.0012);
  });

  test('writes breakdown attrs for cache + reasoning when present', () => {
    const span = makeSpan();
    recordLLMCall(span, {
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 1000 },
      cost: {
        cost: 0.0001,
        costType: 'estimated',
        breakdown: { input: 0, output: 0, cache_read: 0.0001 },
      },
    });
    expect(span.attrs[GEN_AI_COST_CACHE_READ]).toBe(0.0001);
    expect(span.attrs[GEN_AI_COST_CACHE_WRITE]).toBeUndefined();
  });

  test('unknown cost: writes type but not a misleading $0', () => {
    const span = makeSpan();
    recordLLMCall(span, {
      usage: { input_tokens: 10, output_tokens: 5 },
      cost: { cost: 0, costType: 'unknown' },
    });
    expect(span.attrs[GEN_AI_COST_TYPE]).toBe('unknown');
    expect(span.attrs[GEN_AI_COST_TOTAL]).toBeUndefined();
    expect(span.attrs[LLM_COST_TOTAL]).toBeUndefined();
  });

  test('no cost arg: only token attrs emitted', () => {
    const span = makeSpan();
    recordLLMCall(span, { usage: { input_tokens: 10, output_tokens: 5 } });
    expect(span.attrs[GEN_AI_COST_TOTAL]).toBeUndefined();
    expect(span.attrs[GEN_AI_COST_TYPE]).toBeUndefined();
  });

  test('round to 8 decimal places (no trailing-float artifacts)', () => {
    const span = makeSpan();
    recordLLMCall(span, {
      usage: { input_tokens: 1, output_tokens: 1 },
      cost: { cost: 0.0000000012345678, costType: 'estimated', breakdown: { input: 0, output: 0 } },
    });
    expect(span.attrs[GEN_AI_COST_TOTAL]).toBe(0.00000000); // rounds to 8dp
  });
});
