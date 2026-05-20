/**
 * OpenAI → {@link LLMUsage}.
 *
 * Handles three flavours sharing the same wire shape:
 *   - OpenAI native (chat.completions + responses APIs)
 *   - OpenRouter (OpenAI-compatible relay; also reports `usage.cost`)
 *   - Azure OpenAI (identical usage shape)
 *
 * Wire shape:
 *
 *   {
 *     prompt_tokens, completion_tokens, total_tokens,
 *     prompt_tokens_details?:     { cached_tokens?: number },
 *     completion_tokens_details?: { reasoning_tokens?: number },
 *     cost?: number,           // OpenRouter only
 *   }
 *
 * Critical: OpenAI reports `prompt_tokens` as GROSS (includes cached
 * portion). The {@link LLMUsage} contract says `input_tokens` is the
 * UNCACHED portion only. We subtract cached_tokens at this boundary so
 * downstream callers don't double-count.
 */

import type { LLMUsage } from '../types.js';

/** Minimal type for OpenAI's usage object (matches OpenAI SDK + OpenRouter). */
export interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  /** OpenRouter exposes the actual provider-reported cost in USD. */
  cost?: number;
}

/**
 * Project an OpenAI-shaped usage payload into the cross-provider
 * {@link LLMUsage} contract.
 *
 * Returns input_tokens = prompt_tokens - cached_tokens (uncached only).
 * Sets cache_read_tokens / reasoning_tokens / provider_cost only when
 * the source emits them — leaves the fields undefined otherwise (don't
 * pollute the contract with zeros that mean "missing").
 */
export function openai(usage: OpenAIUsage | null | undefined): LLMUsage {
  const u = usage ?? {};
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const grossInput = u.prompt_tokens ?? 0;
  return {
    input_tokens:  Math.max(0, grossInput - cached),
    output_tokens: u.completion_tokens ?? 0,
    ...(cached > 0 ? { cache_read_tokens: cached } : {}),
    ...(u.completion_tokens_details?.reasoning_tokens
      ? { reasoning_tokens: u.completion_tokens_details.reasoning_tokens }
      : {}),
    ...(typeof u.cost === 'number' ? { provider_cost: u.cost } : {}),
  };
}
