/**
 * Write LLM usage + cost onto an OTel span.
 *
 * Dual-emits both OTel-GenAI and OpenInference attribute names so
 * downstream tools (Phoenix, Arize, Langfuse, scry, the future
 * OTel-GenAI ratified spec) all read the same span. The function is the
 * canonical place to put attributes — instrumentations (Anthropic /
 * OpenAI / Gemini wrappers) call this rather than setting attrs inline.
 */

import type { Span } from '@opentelemetry/api';
import type { CostResult, LLMUsage } from './types.js';
import {
  emitGenAI,
  emitOpenInference,
  resolveConventionMode,
  type ConventionMode,
} from '../instrument/convention.js';
import {
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_COST_TOTAL,
  GEN_AI_COST_INPUT,
  GEN_AI_COST_OUTPUT,
  GEN_AI_COST_CACHE_READ,
  GEN_AI_COST_CACHE_WRITE,
  GEN_AI_COST_REASONING,
  GEN_AI_COST_TYPE,
  LLM_TOKEN_COUNT_PROMPT,
  LLM_TOKEN_COUNT_COMPLETION,
  LLM_TOKEN_COUNT_TOTAL,
  LLM_TOKEN_COUNT_PROMPT_CACHE_READ,
  LLM_TOKEN_COUNT_PROMPT_CACHE_WRITE,
  LLM_TOKEN_COUNT_COMPLETION_REASONING,
  LLM_COST_TOTAL,
} from './attrs.js';

const GEN_AI_USAGE_CACHE_READ  = 'gen_ai.usage.cache_read.input_tokens';
const GEN_AI_USAGE_CACHE_WRITE = 'gen_ai.usage.cache_creation.input_tokens';
const GEN_AI_USAGE_REASONING   = 'gen_ai.usage.reasoning.output_tokens';

/**
 * Fields recorded on the span. Pass `cost`/`costType`/`breakdown` from
 * a {@link calculateCost} result — or omit entirely to just write token
 * counts when no pricing source is wired.
 */
export interface RecordLLMCallFields {
  usage: LLMUsage;
  /** Result of `calculateCost(model, usage, pricing)`. Omit for token-only emission. */
  cost?: CostResult;
  /**
   * Convention mode override. Defaults to {@link readConventionMode} —
   * driven by `OTEL_SEMCONV_STABILITY_OPT_IN`. Pass explicitly when an
   * instrumentation already resolved its mode and wants to share it.
   */
  conventionMode?: ConventionMode;
}

/**
 * Write token counts + (optional) cost attributes onto a span. By
 * default (mode = `'dup'`) writes BOTH OTel-GenAI (`gen_ai.*`) and
 * OpenInference (`llm.*`) names so either consumer reads the data.
 *
 * Idempotent: safe to call multiple times on the same span (each call
 * overwrites the previous attrs with the same values).
 */
export function recordLLMCall(span: Span, fields: RecordLLMCallFields): void {
  const { usage, cost } = fields;
  const mode = resolveConventionMode({ conventionMode: fields.conventionMode });
  const oi    = emitOpenInference(mode);
  const genai = emitGenAI(mode);

  // ── Token counts ──────────────────────────────────────────────────
  const total = usage.input_tokens + usage.output_tokens;
  if (genai) {
    span.setAttribute(GEN_AI_USAGE_INPUT_TOKENS,  usage.input_tokens);
    span.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, usage.output_tokens);
  }
  if (oi) {
    span.setAttribute(LLM_TOKEN_COUNT_PROMPT,     usage.input_tokens);
    span.setAttribute(LLM_TOKEN_COUNT_COMPLETION, usage.output_tokens);
    span.setAttribute(LLM_TOKEN_COUNT_TOTAL,      total);
  }

  if (usage.cache_read_tokens && usage.cache_read_tokens > 0) {
    if (oi)    span.setAttribute(LLM_TOKEN_COUNT_PROMPT_CACHE_READ, usage.cache_read_tokens);
    if (genai) span.setAttribute(GEN_AI_USAGE_CACHE_READ,           usage.cache_read_tokens);
  }
  if (usage.cache_creation_tokens && usage.cache_creation_tokens > 0) {
    if (oi)    span.setAttribute(LLM_TOKEN_COUNT_PROMPT_CACHE_WRITE, usage.cache_creation_tokens);
    if (genai) span.setAttribute(GEN_AI_USAGE_CACHE_WRITE,           usage.cache_creation_tokens);
  }
  if (usage.reasoning_tokens && usage.reasoning_tokens > 0) {
    if (oi)    span.setAttribute(LLM_TOKEN_COUNT_COMPLETION_REASONING, usage.reasoning_tokens);
    if (genai) span.setAttribute(GEN_AI_USAGE_REASONING,               usage.reasoning_tokens);
  }

  // ── Cost (optional) ───────────────────────────────────────────────
  if (!cost) return;

  // `unknown` provenance: don't write a misleading $0 on the span.
  // Consumers querying "spans with cost" should miss this one, not
  // include it as a spurious zero.
  if (cost.costType === 'unknown') {
    if (genai) span.setAttribute(GEN_AI_COST_TYPE, 'unknown');
    return;
  }

  if (genai) span.setAttribute(GEN_AI_COST_TOTAL, round(cost.cost));
  if (oi)    span.setAttribute(LLM_COST_TOTAL,    round(cost.cost));
  if (genai) span.setAttribute(GEN_AI_COST_TYPE,  cost.costType);

  if (cost.breakdown && genai) {
    if (cost.breakdown.input  !== undefined) span.setAttribute(GEN_AI_COST_INPUT,  round(cost.breakdown.input));
    if (cost.breakdown.output !== undefined) span.setAttribute(GEN_AI_COST_OUTPUT, round(cost.breakdown.output));
    if (cost.breakdown.cache_read     !== undefined) span.setAttribute(GEN_AI_COST_CACHE_READ,  round(cost.breakdown.cache_read));
    if (cost.breakdown.cache_creation !== undefined) span.setAttribute(GEN_AI_COST_CACHE_WRITE, round(cost.breakdown.cache_creation));
    if (cost.breakdown.reasoning      !== undefined) span.setAttribute(GEN_AI_COST_REASONING,   round(cost.breakdown.reasoning));
  }
}

/** Round to 8 decimal places — enough precision for sub-penny tokens
 *  without trailing-float artifacts on the span. */
function round(n: number): number {
  return Number(n.toFixed(8));
}
