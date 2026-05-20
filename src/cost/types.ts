/**
 * Cross-provider LLM cost types.
 *
 * Three primitives:
 *
 *  - `LLMUsage`     — what one LLM call cost in tokens. Cross-provider
 *                     contract; every extractor emits this shape.
 *  - `ModelPricing` — per-model rates. Multipliers on input/output for
 *                     cache and reasoning so per-model variation stays
 *                     compact.
 *  - `PricingSource`— pluggable lookup. agent-otel ships no pricing data;
 *                     users wire static tables, models.dev, LiteLLM JSON,
 *                     or anything else that implements the interface.
 */

/**
 * Token usage for one LLM call. Cross-provider — every extractor in
 * `cost/extractors/*` returns this shape.
 *
 * Critical contract: `input_tokens` is the UNCACHED portion only.
 * `cache_read_tokens` and `cache_creation_tokens` are ADDITIVE (not a
 * subset of input_tokens). Providers that natively report gross totals
 * (OpenAI's `prompt_tokens`) must subtract cache tokens at the
 * extractor boundary.
 */
export interface LLMUsage {
  input_tokens: number;
  output_tokens: number;
  /** Tokens served from a prompt cache (cheaper than uncached input). */
  cache_read_tokens?: number;
  /** Tokens written to the prompt cache (typically a premium over input). */
  cache_creation_tokens?: number;
  /** Reasoning/thinking tokens (o-series, claude-thinking, gemini-thinking). */
  reasoning_tokens?: number;
  /**
   * Provider-reported actual cost in USD. When present + > 0,
   * calculateCost returns it directly (costType: 'actual') and skips the
   * pricing table. Set by extractors that have access to authoritative
   * provider-side numbers (OpenRouter exposes `usage.cost`; Bedrock can
   * surface line-item charges).
   */
  provider_cost?: number;
}

/**
 * Per-model pricing. Multiplier-based so the table stays compact while
 * letting per-model variation (different cache discount across providers)
 * carry through.
 *
 * Anthropic's prompt-cache: read ≈ 10% of input, write ≈ 125%.
 * OpenAI's: read ≈ 50% of input, no separate write rate (free).
 * Override per-model when defaults don't match the provider's docs.
 */
export interface ModelPricing {
  /** USD per million uncached input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /**
   * Multiplier on `input` for cache reads. Default = 0.1 (Anthropic legacy).
   * Set to 0.5 for OpenAI, 0 if the provider doesn't bill cache reads, etc.
   */
  cache_read_multiplier?: number;
  /**
   * Multiplier on `input` for cache writes (cold creation).
   * Default = 1.25 (Anthropic).
   */
  cache_creation_multiplier?: number;
  /**
   * USD per million reasoning tokens. Default = `output` (matches Claude
   * Extended Thinking + o1 today). Set explicitly when a provider bills
   * reasoning differently from regular output.
   */
  reasoning?: number;
}

/**
 * Pluggable price lookup. agent-otel ships NO pricing data — users
 * implement this against a static table, a fetched dump from models.dev,
 * LiteLLM's JSON, a database row, or any other source. The contract is
 * the only thing the package owns.
 *
 * Sources should be cheap to call: `calculateCost` looks up once per
 * call. Caching is the source's responsibility (don't hit network on
 * every lookup).
 */
export interface PricingSource {
  /** Return per-model rates, or undefined when the model isn't known. */
  lookup(model: string): ModelPricing | undefined;
}

/** Result shape from {@link calculateCost}. */
export interface CostResult {
  /** Total cost in USD. 0 when pricing source returns undefined. */
  cost: number;
  /**
   * Provenance:
   *  - `'actual'`    — pulled from `usage.provider_cost` (authoritative)
   *  - `'estimated'` — computed from `pricing.lookup(model)` + token counts
   *  - `'unknown'`   — model not in pricing source; cost is 0
   */
  costType: 'actual' | 'estimated' | 'unknown';
  /**
   * Per-bucket breakdown (estimated calls only). Empty when costType ===
   * 'actual' — provider-reported numbers don't separate per bucket — or
   * `'unknown'`. Useful for "where's my spend going?" dashboards.
   */
  breakdown?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_creation?: number;
    reasoning?: number;
  };
}
