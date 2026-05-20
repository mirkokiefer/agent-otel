/**
 * OTel attribute name constants for LLM observability.
 *
 * Dual-emit both conventions so consumers don't have to pick:
 *
 *  - **OTel-GenAI** (`gen_ai.*`) — the official OpenTelemetry GenAI
 *    semantic-conventions spec. Token counts are stable; cost attrs are
 *    proposed (see the spec PR).
 *  - **OpenInference** (`llm.*`) — Arize's convention. What Phoenix /
 *    Arize / Langfuse / scry read today. Has `llm.cost.total` already.
 *
 * Writing both means: dashboards built against either vocab work without
 * a translation layer. When OTel-GenAI ratifies cost attrs, OpenInference
 * stays as the legacy alias; consumers can migrate at their own pace.
 *
 * Use these constants instead of inline strings — single point of truth,
 * no typos.
 */

// ─────────────────────────────────────────────────────────────────────
//  OTel-GenAI (primary going forward)
// ─────────────────────────────────────────────────────────────────────

/** UNCACHED input tokens. Stable in the OTel-GenAI spec. */
export const GEN_AI_USAGE_INPUT_TOKENS  = 'gen_ai.usage.input_tokens';
/** Output / completion tokens. Stable in the OTel-GenAI spec. */
export const GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';

/**
 * Total USD cost. Proposed (not yet stable in OTel-GenAI as of writing);
 * agent-otel writes it as part of the package's push to standardise
 * cost attributes upstream. Mirror of OpenInference's `llm.cost.total`.
 */
export const GEN_AI_COST_TOTAL          = 'gen_ai.cost.total';
/** Per-bucket cost breakdown (proposed). */
export const GEN_AI_COST_INPUT          = 'gen_ai.cost.input';
export const GEN_AI_COST_OUTPUT         = 'gen_ai.cost.output';
export const GEN_AI_COST_CACHE_READ     = 'gen_ai.cost.cache_read';
export const GEN_AI_COST_CACHE_WRITE    = 'gen_ai.cost.cache_write';
export const GEN_AI_COST_REASONING      = 'gen_ai.cost.reasoning';
/** `'actual' | 'estimated' | 'unknown'` — provenance of `cost.total`. */
export const GEN_AI_COST_TYPE           = 'gen_ai.cost.type';

// ─────────────────────────────────────────────────────────────────────
//  OpenInference (current tooling reads these)
// ─────────────────────────────────────────────────────────────────────

export const LLM_TOKEN_COUNT_PROMPT                   = 'llm.token_count.prompt';
export const LLM_TOKEN_COUNT_COMPLETION               = 'llm.token_count.completion';
export const LLM_TOKEN_COUNT_TOTAL                    = 'llm.token_count.total';
export const LLM_TOKEN_COUNT_PROMPT_CACHE_READ        = 'llm.token_count.prompt_details.cache_read';
export const LLM_TOKEN_COUNT_PROMPT_CACHE_WRITE       = 'llm.token_count.prompt_details.cache_write';
export const LLM_TOKEN_COUNT_COMPLETION_REASONING     = 'llm.token_count.completion_details.reasoning';
export const LLM_COST_TOTAL                           = 'llm.cost.total';
