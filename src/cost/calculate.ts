/**
 * Compute the cost of one LLM call.
 *
 * Single function, deterministic, no side effects. Reused by:
 *
 *  - `recordLLMCall(span, …)` — writes the result onto OTel spans
 *  - Direct callers who want the number (billing, budget gates, dashboards)
 *
 * Pricing data is supplied by the caller via {@link PricingSource}. The
 * package itself ships no rates — see `docs/PRICING.md` for example
 * adapters (static table, models.dev fetch, LiteLLM JSON).
 */

import type { CostResult, LLMUsage, ModelPricing, PricingSource } from './types.js';

/**
 * Compute the USD cost for one LLM call.
 *
 * Resolution order:
 *  1. If `usage.provider_cost` is present and > 0, return it as
 *     `costType: 'actual'`. OpenRouter / Bedrock-line-item / any
 *     authoritative provider-side number wins over an estimate.
 *  2. Else look the model up in `pricing`. If found, compute cost from
 *     `usage` tokens × per-bucket rates and return as `'estimated'`
 *     with a breakdown.
 *  3. Else return `{ cost: 0, costType: 'unknown' }`. Loud-fail at
 *     read time on dashboards (cost shows 0) is cleaner than silently
 *     returning estimates against a missing table.
 *
 * Math (all rates are per-million tokens):
 *
 *   cost = (input_tokens × pricing.input
 *         + cache_read_tokens × pricing.input × cache_read_multiplier
 *         + cache_creation_tokens × pricing.input × cache_creation_multiplier
 *         + output_tokens × pricing.output
 *         + reasoning_tokens × (pricing.reasoning ?? pricing.output))
 *         / 1_000_000
 *
 * `input_tokens` is the UNCACHED portion only — extractors enforce this
 * at the provider boundary. Don't subtract cache from input here.
 */
export function calculateCost(
  model: string,
  usage: LLMUsage,
  pricing: PricingSource,
): CostResult {
  // 1) Authoritative provider-reported cost wins. Treat 0 as "not
  //    reported" — a legitimate $0 (free models) hits the same result
  //    via the estimate path and we don't want bogus upstream zeros to
  //    masquerade as actuals.
  if (usage.provider_cost != null && usage.provider_cost > 0) {
    return { cost: usage.provider_cost, costType: 'actual' };
  }

  // 2) Estimate from the pricing table.
  const p = pricing.lookup(model);
  if (!p) {
    return { cost: 0, costType: 'unknown' };
  }

  return estimateFromTable(usage, p);
}

function estimateFromTable(usage: LLMUsage, p: ModelPricing): CostResult {
  const cacheReadMul = p.cache_read_multiplier ?? 0.1;
  const cacheWriteMul = p.cache_creation_multiplier ?? 1.25;
  const reasoningRate = p.reasoning ?? p.output;

  const input  = (usage.input_tokens  * p.input)  / 1_000_000;
  const output = (usage.output_tokens * p.output) / 1_000_000;
  const cache_read = usage.cache_read_tokens
    ? (usage.cache_read_tokens * p.input * cacheReadMul) / 1_000_000
    : undefined;
  const cache_creation = usage.cache_creation_tokens
    ? (usage.cache_creation_tokens * p.input * cacheWriteMul) / 1_000_000
    : undefined;
  const reasoning = usage.reasoning_tokens
    ? (usage.reasoning_tokens * reasoningRate) / 1_000_000
    : undefined;

  const cost = input + output + (cache_read ?? 0) + (cache_creation ?? 0) + (reasoning ?? 0);

  return {
    cost,
    costType: 'estimated',
    breakdown: {
      input,
      output,
      ...(cache_read     !== undefined ? { cache_read } : {}),
      ...(cache_creation !== undefined ? { cache_creation } : {}),
      ...(reasoning      !== undefined ? { reasoning } : {}),
    },
  };
}
