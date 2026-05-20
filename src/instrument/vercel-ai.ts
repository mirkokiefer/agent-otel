/**
 * Auto-instrument the Vercel AI SDK via its native middleware pattern.
 *
 *   import { generateText, wrapLanguageModel } from 'ai';
 *   import { anthropic } from '@ai-sdk/anthropic';
 *   import { tracingMiddleware } from 'agent-otel/vercel-ai';
 *
 *   const model = wrapLanguageModel({
 *     model:      anthropic('claude-sonnet-4-7'),
 *     middleware: tracingMiddleware(),
 *   });
 *
 *   const { text } = await generateText({ model, prompt: 'Hello' });
 *   // ↑ emits an OpenInference span automatically — same shape as
 *   // agent-otel/anthropic and agent-otel/openai produce
 *
 * Why a middleware (and not a Proxy like the Anthropic / OpenAI
 * instruments)? Vercel AI SDK ships `wrapLanguageModel` for exactly this
 * use case. Going through their middleware contract means we get
 * unified results (their normalized shape) regardless of which underlying
 * provider the agent author swaps in. One adapter; works with Anthropic,
 * OpenAI, Gemini, Mistral, anything that has an `@ai-sdk/<vendor>` package.
 *
 * Output attributes follow the same OpenInference convention as the
 * other instrument modules:
 *   gen_ai.system        ← model.provider (e.g. 'anthropic', 'openai')
 *   llm.system           ← same
 *   llm.provider         ← same
 *   llm.model_name       ← model.modelId
 *   llm.input_messages.* ← params.prompt flattened
 *   llm.tools.*          ← params.tools flattened
 *   llm.token_count.*    ← result.usage
 *   llm.cost.total       ← computed when costPerToken given (see options)
 *   openinference.span.kind = 'LLM'
 *
 * Streaming (`wrapStream`) passes through unwrapped in v1 — same trade-off
 * as the other instruments. Full stream-wrap with progressive token
 * emission lands in v2.
 */

import { trace, SpanStatusCode, SpanKind as OTelSpanKind, type Span } from '@opentelemetry/api';
import { resolveConventionMode, emitOpenInference, emitGenAI, type ConventionMode } from './convention.js';
import { setLLMFoundation, setLLMSampling, setLLMResponse } from './genai-attributes.js';

const tracer = trace.getTracer('agent-otel/vercel-ai', '0.0.14');

const MAX_RAW_REQUEST = 64_000;
const MAX_MESSAGE_CONTENT = 16_000;
const MAX_TOOL_SCHEMA = 20_000;

function truncate(s: string, limit: number): string {
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `…[truncated ${s.length - limit} chars]`;
}

interface TracingMiddlewareOptions {
  /**
   * Per-token cost table, keyed by `<provider>:<model>` or just `<model>`.
   * Looked up by longest-prefix match. Values in USD per token.
   */
  costPerToken?: Record<string, { input: number; output: number; cached?: number }>;
  /**
   * Override the span name. Default: `chat <provider> <model>`.
   */
  spanName?: (model: { provider: string; modelId: string }) => string;
  /**
   * Convention mode override. When unset, reads
   * `OTEL_SEMCONV_STABILITY_OPT_IN` (default `'dup'`).
   */
  conventionMode?: ConventionMode;
}

// Loose types — we don't import @ai-sdk/provider's exact LanguageModelV3*
// shapes because that would lock us to a major version. We rely on the
// well-known fields documented in the AI SDK docs and treat unknowns as
// optional.
interface VercelMiddleware {
  middlewareVersion?: 'v3' | 'v2';
  wrapGenerate?: (opts: {
    doGenerate: () => Promise<unknown>;
    doStream:   () => Promise<unknown>;
    params:     Record<string, unknown>;
    model:      { provider: string; modelId: string; specificationVersion?: string };
  }) => Promise<unknown>;
  wrapStream?: (opts: {
    doGenerate: () => Promise<unknown>;
    doStream:   () => Promise<unknown>;
    params:     Record<string, unknown>;
    model:      { provider: string; modelId: string; specificationVersion?: string };
  }) => Promise<unknown>;
}

export function tracingMiddleware(opts: TracingMiddlewareOptions = {}): VercelMiddleware {
  const mode = resolveConventionMode(opts);
  return {
    middlewareVersion: 'v3',

    async wrapGenerate({ doGenerate, params, model }) {
      const spanName = opts.spanName?.(model)
        ?? `chat ${normalizeProvider(model.provider)} ${model.modelId}`;
      const span = tracer.startSpan(spanName, { kind: OTelSpanKind.CLIENT });

      try {
        stampInputAttributes(span, params, model, mode);
      } catch (err) {
        console.warn('[agent-otel/vercel-ai] input stamping failed:', err);
      }

      try {
        const result = await doGenerate();
        try {
          stampOutputAttributes(span, model, result, opts.costPerToken, mode);
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (err) {
          console.warn('[agent-otel/vercel-ai] output stamping failed:', err);
        }
        return result;
      } catch (err: unknown) {
        const e = err as Error;
        span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
        span.recordException(e);
        throw err;
      } finally {
        span.end();
      }
    },

    // Streaming pass-through in v1 — same trade-off as anthropic/openai
    // instruments. Real stream wrapping with progressive emission later.
  };
}

// ---------------------------------------------------------------------------
// Attribute stampers
// ---------------------------------------------------------------------------

/**
 * AI SDK provider strings come in two flavors:
 *   - bare:   'anthropic', 'openai'
 *   - dotted: 'anthropic.messages', 'openai.chat'   (provider + endpoint)
 *
 * We normalize to the bare vendor for `gen_ai.system` / `llm.system`
 * (matches what the direct anthropic / openai instrument modules emit),
 * and keep the full string under `llm.ai_sdk.provider` for completeness.
 */
function normalizeProvider(p: string): string {
  return p.split('.')[0] ?? p;
}

function stampInputAttributes(span: Span, params: Record<string, unknown>, model: { provider: string; modelId: string }, mode: ConventionMode): void {
  const provider = normalizeProvider(model.provider);

  setLLMFoundation(span, { provider, model: model.modelId }, mode);
  if (provider !== model.provider && emitOpenInference(mode)) {
    span.setAttribute('llm.ai_sdk.provider', model.provider);
  }
  setLLMSampling(span, {
    temperature: typeof params.temperature === 'number' ? params.temperature : undefined,
    max_tokens:  typeof params.maxOutputTokens === 'number' ? params.maxOutputTokens : undefined,
    top_p:       typeof params.topP             === 'number' ? params.topP             : undefined,
    top_k:       typeof params.topK             === 'number' ? params.topK             : undefined,
    frequency_penalty: typeof params.frequencyPenalty === 'number' ? params.frequencyPenalty : undefined,
    presence_penalty:  typeof params.presencePenalty  === 'number' ? params.presencePenalty  : undefined,
    seed:        typeof params.seed              === 'number' ? params.seed              : undefined,
    stop_sequences: Array.isArray(params.stopSequences) ? (params.stopSequences as string[]) : undefined,
  }, mode);

  // Content stays OpenInference-flat for now; gated on mode.
  if (!emitOpenInference(mode)) return;

  // Vercel AI SDK normalizes prompts to a `prompt: LanguageModelV3Prompt` array.
  // Each element: { role: 'system'|'user'|'assistant'|'tool', content: ... }.
  const prompt = params.prompt;
  if (Array.isArray(prompt)) {
    let idx = 0;
    for (const msg of prompt as Array<Record<string, unknown>>) {
      const role = String(msg.role ?? 'user');
      const prefix = `llm.input_messages.${idx}.message`;
      span.setAttribute(`${prefix}.role`, role);

      const flat = flattenContent(msg.content);
      if (flat) span.setAttribute(`${prefix}.content`, truncate(flat, MAX_MESSAGE_CONTENT));

      // Tool calls inside an assistant message
      if (Array.isArray(msg.content)) {
        let tcIdx = 0;
        for (const block of msg.content as Array<Record<string, unknown>>) {
          if (block.type === 'tool-call') {
            const tcPrefix = `${prefix}.tool_calls.${tcIdx}`;
            span.setAttribute(`${tcPrefix}.tool_call.id`,                  String(block.toolCallId ?? ''));
            span.setAttribute(`${tcPrefix}.tool_call.function.name`,       String(block.toolName ?? ''));
            span.setAttribute(`${tcPrefix}.tool_call.function.arguments`,
              truncate(JSON.stringify(block.input ?? {}), MAX_MESSAGE_CONTENT));
            tcIdx++;
          }
        }
      }

      idx++;
    }
  }

  // Tool definitions: AI SDK normalizes to params.tools = [{ type: 'function', name, description, inputSchema }, ...]
  const tools = params.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    span.setAttribute('llm.tools.count', tools.length);
    tools.forEach((t, i) => {
      const td = t as Record<string, unknown>;
      span.setAttribute(`llm.tools.${i}.tool.json_schema`,
        truncate(JSON.stringify({ name: td.name, description: td.description, parameters: td.inputSchema }), MAX_TOOL_SCHEMA),
      );
    });
  }

  // Replayable raw request body — AI SDK params include the normalized prompt,
  // tools, and options. Strip any base64 file blocks first.
  try {
    const stripped = {
      prompt: Array.isArray(prompt) ? prompt.map(stripBinaryFromMessage) : prompt,
      tools,
      temperature:     params.temperature,
      maxOutputTokens: params.maxOutputTokens,
      providerOptions: params.providerOptions,
    };
    const raw = JSON.stringify(stripped);
    span.setAttribute('llm.request.body',       truncate(raw, MAX_RAW_REQUEST));
    span.setAttribute('llm.request.body_bytes', raw.length);
  } catch {
    // circular refs — skip raw body
  }
}

function stampOutputAttributes(
  span: Span,
  model: { provider: string; modelId: string },
  result: unknown,
  costPerToken: Record<string, { input: number; output: number; cached?: number }> | undefined,
  mode: ConventionMode,
): void {
  const r = result as Record<string, unknown>;
  const oi = emitOpenInference(mode);
  const genai = emitGenAI(mode);

  const finishReasonType = r.finishReason && typeof (r.finishReason as Record<string, unknown>).type === 'string'
    ? String((r.finishReason as Record<string, unknown>).type)
    : undefined;
  setLLMResponse(span, {
    finishReasons: finishReasonType ? [finishReasonType] : undefined,
  }, mode);

  // Content stays OpenInference-flat (gated on mode).
  let text = '';
  let toolCallCount = 0;
  if (Array.isArray(r.content)) {
    for (const block of r.content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string') text += block.text;
      if (block.type === 'tool-call') toolCallCount++;
    }
  }

  if (oi) {
    span.setAttribute('llm.output_messages.0.message.role', 'assistant');
    let tcIdx = 0;
    if (Array.isArray(r.content)) {
      for (const block of r.content as Array<Record<string, unknown>>) {
        if (block.type === 'tool-call') {
          const prefix = `llm.output_messages.0.message.tool_calls.${tcIdx}`;
          span.setAttribute(`${prefix}.tool_call.id`,                  String(block.toolCallId ?? ''));
          span.setAttribute(`${prefix}.tool_call.function.name`,       String(block.toolName ?? ''));
          span.setAttribute(`${prefix}.tool_call.function.arguments`,
            truncate(JSON.stringify(block.input ?? {}), MAX_MESSAGE_CONTENT));
          tcIdx++;
        }
      }
    }
    if (text) span.setAttribute('llm.output_messages.0.message.content', truncate(text, MAX_MESSAGE_CONTENT));
    if (toolCallCount > 0) span.setAttribute('llm.tool_calls.count', toolCallCount);
  }

  // Tokens + cost — bespoke math here (vercel AI SDK's normalized usage
  // shape pre-dates the cost module's extractors). Mode gates the
  // attribute name set written.
  const usage = r.usage as Record<string, unknown> | undefined;
  if (!usage) return;
  const input  = readTokenTotal(usage.inputTokens);
  const output = readTokenTotal(usage.outputTokens);
  if (input !== undefined) {
    if (oi)    span.setAttribute('llm.token_count.prompt',    input);
    if (genai) span.setAttribute('gen_ai.usage.input_tokens', input);
  }
  if (output !== undefined) {
    if (oi)    span.setAttribute('llm.token_count.completion', output);
    if (genai) span.setAttribute('gen_ai.usage.output_tokens', output);
  }
  if (oi && input !== undefined && output !== undefined) {
    span.setAttribute('llm.token_count.total', input + output);
  }

  const inputDetails  = usage.inputTokens  as Record<string, unknown> | undefined;
  const outputDetails = usage.outputTokens as Record<string, unknown> | undefined;
  const cached        = readTokenTotal(inputDetails?.cached);
  const reasoning     = readTokenTotal(outputDetails?.reasoning);
  if (cached !== undefined && cached > 0) {
    if (oi)    span.setAttribute('llm.token_count.prompt_details.cache_read', cached);
    if (genai) span.setAttribute('gen_ai.usage.cache_read.input_tokens',      cached);
  }
  if (reasoning !== undefined && reasoning > 0) {
    if (oi)    span.setAttribute('llm.token_count.completion_details.reasoning', reasoning);
    if (genai) span.setAttribute('gen_ai.usage.reasoning.output_tokens',         reasoning);
  }

  const rate = costPerToken ? lookupCost(model, costPerToken) : undefined;
  if (rate && input !== undefined && output !== undefined) {
    const promptCost = input * rate.input;
    const cacheCost  = rate.cached && cached ? cached * rate.cached : 0;
    const completionCost = output * rate.output;
    const total = Number((promptCost + cacheCost + completionCost).toFixed(8));
    if (oi)    span.setAttribute('llm.cost.total',    total);
    if (genai) span.setAttribute('gen_ai.cost.total', total);
    if (genai) span.setAttribute('gen_ai.cost.type',  'estimated');
  }
}

function readTokenTotal(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && 'total' in v && typeof (v as { total: unknown }).total === 'number') {
    return (v as { total: number }).total;
  }
  return undefined;
}

function lookupCost(
  model: { provider: string; modelId: string },
  costs: Record<string, { input: number; output: number; cached?: number }>,
): { input: number; output: number; cached?: number } | undefined {
  const provider = normalizeProvider(model.provider);
  const candidates = [
    `${model.provider}:${model.modelId}`,
    `${provider}:${model.modelId}`,
    model.modelId,
  ];
  for (const c of candidates) {
    if (costs[c]) return costs[c];
    const prefix = Object.keys(costs).filter(k => c.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    if (prefix) return costs[prefix];
  }
  return undefined;
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push(`[image: ${block.mediaType ?? 'unknown'}]`);
    else if (block.type === 'file')  parts.push(`[file: ${block.mediaType ?? 'unknown'}]`);
    else if (block.type === 'tool-result') {
      const inner = flattenContent(block.output);
      if (inner) parts.push(`[tool_result ${block.toolCallId ?? ''}: ${inner}]`);
    }
  }
  return parts.join('\n');
}

function stripBinaryFromMessage(msg: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(msg.content)) return msg;
  const stripped = (msg.content as Array<Record<string, unknown>>).map((block) => {
    if (block.type === 'image' || block.type === 'file') {
      const data = block.data;
      const dataLen = typeof data === 'string' ? data.length : 0;
      return { ...block, data: `[stripped: ${dataLen} base64 chars]` };
    }
    return block;
  });
  return { ...msg, content: stripped };
}
