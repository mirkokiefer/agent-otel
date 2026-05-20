/**
 * agent-otel cost module.
 *
 *   import {
 *     calculateCost, recordLLMCall, extractors,
 *     type LLMUsage, type PricingSource, type ModelPricing, type CostResult,
 *   } from 'agent-otel/cost';
 *
 * Three primitives:
 *
 *  - **`extractors.openai|anthropic|gemini(rawUsage)`** — project a
 *    provider-specific usage payload into the cross-provider
 *    {@link LLMUsage} contract.
 *  - **`calculateCost(model, usage, pricing)`** — cost math against a
 *    pluggable pricing source. Prefers provider-reported actuals
 *    (OpenRouter) over estimates.
 *  - **`recordLLMCall(span, { usage, cost? })`** — write OTel-GenAI
 *    AND OpenInference attributes onto an OTel span. Dual-emit so
 *    Phoenix, Arize, Langfuse, scry, and future OTel-GenAI consumers
 *    all read the same data.
 *
 * Three-line wire-up:
 *
 *   const myPricing: PricingSource = { lookup: (m) => MY_TABLE[m] };
 *
 *   const usage = extractors.openai(chunk.usage);
 *   const cost  = calculateCost(model, usage, myPricing);
 *   recordLLMCall(span, { usage, cost });
 *
 * The package SHIPS NO PRICING DATA — supply your own. See
 * `examples/pricing-*.ts` for static / models.dev / LiteLLM adapters.
 */

export * from './types.js';
export { calculateCost } from './calculate.js';
export { recordLLMCall, type RecordLLMCallFields } from './record.js';
export * as extractors from './extractors/index.js';
export * as attrs from './attrs.js';
