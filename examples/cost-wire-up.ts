/**
 * End-to-end example: extracting → costing → recording.
 *
 * This is what every consumer of `agent-otel/cost` does. Three lines
 * inside your provider stream's "finish" handler. The package handles
 * the math + the attribute names; you handle the pricing source.
 */

import { trace } from '@opentelemetry/api';
import { calculateCost, recordLLMCall, extractors } from '../src/cost/index.js';
import { staticPricing } from './pricing-static.js';

const tracer = trace.getTracer('my-agent');

// Simulated OpenAI usage payload (e.g. last chunk of a stream).
const openaiUsageChunk = {
  prompt_tokens: 1500,
  completion_tokens: 240,
  prompt_tokens_details: { cached_tokens: 1000 },
};

// In your stream's finish handler:
const span = tracer.startSpan('chat openai gpt-5');
try {
  const usage = extractors.openai(openaiUsageChunk);
  const cost  = calculateCost('gpt-5', usage, staticPricing);
  recordLLMCall(span, { usage, cost });

  // ↑ The span now carries BOTH:
  //
  //   gen_ai.usage.input_tokens                    500    (uncached)
  //   gen_ai.usage.output_tokens                   240
  //   gen_ai.cost.total                            <usd>
  //   gen_ai.cost.input/output/cache_read          <bucket>
  //   gen_ai.cost.type                             "estimated"
  //
  //   llm.token_count.prompt                       500
  //   llm.token_count.completion                   240
  //   llm.token_count.total                        740
  //   llm.token_count.prompt_details.cache_read    1000
  //   llm.cost.total                               <usd>
  //
  // Phoenix / Arize / Langfuse / scry / Datadog GenAI / any future
  // OTel-GenAI consumer all read the same span.
} finally {
  span.end();
}

// ── Pattern 2: OpenRouter (provider-reported cost) ──────────────────
const openrouterChunk = {
  prompt_tokens: 800, completion_tokens: 120,
  cost: 0.0042,  // ← authoritative; calculateCost returns this verbatim
};
const usage2 = extractors.openai(openrouterChunk);  // OpenRouter is OpenAI-compat
const cost2  = calculateCost('anthropic/claude-sonnet-4-7', usage2, staticPricing);
// cost2.costType === 'actual', cost2.cost === 0.0042
console.log(cost2);
