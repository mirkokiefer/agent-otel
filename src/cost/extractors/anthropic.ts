/**
 * Anthropic → {@link LLMUsage}.
 *
 * Anthropic's wire shape:
 *
 *   {
 *     input_tokens,                  // already UNCACHED (Anthropic convention)
 *     output_tokens,
 *     cache_read_input_tokens?,      // additive — NOT a subset of input_tokens
 *     cache_creation_input_tokens?,  // additive
 *   }
 *
 * Unlike OpenAI, Anthropic's `input_tokens` is ALREADY the uncached
 * portion — they report cache reads/writes as separate additive fields.
 * So no subtraction here; just a straight projection.
 */

import type { LLMUsage } from '../types.js';

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Project an Anthropic-shaped usage payload into the cross-provider
 * {@link LLMUsage} contract. Field rename only — no math.
 */
export function anthropic(usage: AnthropicUsage | null | undefined): LLMUsage {
  const u = usage ?? {};
  return {
    input_tokens:  u.input_tokens  ?? 0,
    output_tokens: u.output_tokens ?? 0,
    ...(u.cache_read_input_tokens
      ? { cache_read_tokens: u.cache_read_input_tokens }
      : {}),
    ...(u.cache_creation_input_tokens
      ? { cache_creation_tokens: u.cache_creation_input_tokens }
      : {}),
  };
}
