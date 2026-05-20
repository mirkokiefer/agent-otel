/**
 * Gemini / Vertex AI → {@link LLMUsage}.
 *
 * Wire shape (`usageMetadata`):
 *
 *   {
 *     promptTokenCount,                  // GROSS — includes cached
 *     candidatesTokenCount,              // output
 *     cachedContentTokenCount?,          // cached portion of prompt
 *     thoughtsTokenCount?,               // reasoning (gemini-thinking)
 *     totalTokenCount,
 *   }
 *
 * Like OpenAI, `promptTokenCount` is gross — we subtract
 * `cachedContentTokenCount` at the boundary.
 *
 * Gemini doesn't expose a provider-reported cost.
 */

import type { LLMUsage } from '../types.js';

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

export function gemini(usage: GeminiUsageMetadata | null | undefined): LLMUsage {
  const u = usage ?? {};
  const cached = u.cachedContentTokenCount ?? 0;
  const grossInput = u.promptTokenCount ?? 0;
  return {
    input_tokens:  Math.max(0, grossInput - cached),
    output_tokens: u.candidatesTokenCount ?? 0,
    ...(cached > 0 ? { cache_read_tokens: cached } : {}),
    ...(u.thoughtsTokenCount
      ? { reasoning_tokens: u.thoughtsTokenCount }
      : {}),
  };
}
