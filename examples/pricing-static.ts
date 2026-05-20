/**
 * Example: a static pricing source.
 *
 * Lift-and-shift this file into your project and adjust the table.
 * agent-otel ships NO pricing data — that's the user's responsibility.
 *
 * The rates below are illustrative. Verify against each provider's
 * current pricing page before relying on them.
 */

import type { ModelPricing, PricingSource } from '../src/cost/types.js';

// USD per MILLION tokens. Cache multipliers apply on top of `input`.
const TABLE: Record<string, ModelPricing> = {
  // ── Anthropic ────────────────────────────────────────────────────
  'claude-opus-4-7':   { input: 15, output: 75, cache_read_multiplier: 0.1, cache_creation_multiplier: 1.25 },
  'claude-sonnet-4-7': { input: 3,  output: 15, cache_read_multiplier: 0.1, cache_creation_multiplier: 1.25 },
  'claude-haiku-4-5':  { input: 1,  output: 5,  cache_read_multiplier: 0.1, cache_creation_multiplier: 1.25 },

  // ── OpenAI ───────────────────────────────────────────────────────
  // OpenAI prompt cache: read at 50% off, no cache-write line item.
  'gpt-5':       { input: 10,  output: 40,  cache_read_multiplier: 0.5 },
  'gpt-5-mini':  { input: 0.4, output: 1.6, cache_read_multiplier: 0.5 },
  'gpt-5-nano':  { input: 0.1, output: 0.4, cache_read_multiplier: 0.5 },
  // o1/o3 — reasoning bills at output rate (default) unless the provider says otherwise.
  'o3':          { input: 15,  output: 60,  cache_read_multiplier: 0.5 },

  // ── Gemini ───────────────────────────────────────────────────────
  'gemini-2.5-pro':   { input: 1.25, output: 10  },
  'gemini-2.5-flash': { input: 0.30, output: 2.5 },
};

export const staticPricing: PricingSource = {
  lookup: (model) => TABLE[model],
};
