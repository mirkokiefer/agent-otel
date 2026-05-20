/**
 * Auto-instrument the OpenAI SDK.
 *
 *   import OpenAI from 'openai';
 *   import { instrument } from 'agent-otel/openai';
 *
 *   const client = instrument(new OpenAI({ apiKey: '...' }));
 *
 *   const resp = await client.chat.completions.create({
 *     model: 'gpt-5.5',
 *     messages: [{ role: 'user', content: 'Hello' }],
 *   });
 *
 * Wraps `client.chat.completions.create`. The Responses API
 * (`client.responses.create`) lands in v2.
 *
 * What gets emitted (OpenInference convention):
 *   span.name             = `chat openai <model>`
 *   span.kind             = CLIENT
 *   gen_ai.system         = 'openai'
 *   gen_ai.request.model  = body.model
 *   llm.model_name        = body.model
 *   llm.system            = 'openai'
 *   llm.input_messages.*  = flattened messages
 *   llm.tools.*           = flattened tool definitions
 *   llm.request.body      = full JSON request (binary stripped, truncated 64KB)
 *   llm.token_count.*     = prompt / completion / total / cached / reasoning
 *   llm.cost.total        = best-effort USD; override via instrument(client, { costPerToken })
 *   openinference.span.kind = 'LLM'
 *   llm.response.{id, finish_reason}
 *
 * Streaming (body.stream === true) passes through without instrumentation
 * in v1 — non-streaming covers the common tool-calling loop. Stream wrap
 * with progressive emission lands in v2.
 */

import { trace, SpanStatusCode, SpanKind as OTelSpanKind, type Span } from '@opentelemetry/api';

import { calculateCost, recordLLMCall, extractors, type ModelPricing, type PricingSource } from '../cost/index.js';
import { resolveConventionMode, emitOpenInference, type ConventionMode } from './convention.js';
import { setLLMFoundation, setLLMSampling, setLLMResponse } from './genai-attributes.js';

const tracer = trace.getTracer('agent-otel/openai', '0.0.18');

const MAX_RAW_REQUEST = 64_000;
const MAX_MESSAGE_CONTENT = 16_000;
const MAX_TOOL_SCHEMA = 20_000;

function truncate(s: string, limit: number): string {
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `…[truncated ${s.length - limit} chars]`;
}

interface InstrumentOptions {
  /**
   * Pricing source for cost calculation. agent-otel ships no pricing
   * data — bring your own (see `examples/pricing-*.ts`). When absent
   * (and `costPerToken` isn't set either), token counts still flow
   * to the span but `llm.cost.total` / `gen_ai.cost.total` are
   * omitted.
   */
  pricing?: PricingSource;

  /**
   * Legacy per-token override. Keys are model names; values are
   * `{ input, output, cached? }` in USD per token. Prefer `pricing`
   * for new code. Adapter converts per-token → per-million for the
   * canonical {@link PricingSource} shape. OpenAI ships date-suffixed
   * IDs (`gpt-5.5-2026-04-23`); the longest-prefix lookup the legacy
   * version did is preserved.
   */
  costPerToken?: Record<string, { input: number; output: number; cached?: number }>;

  /**
   * Provider tag for the span attributes. Defaults to `'openai'`. Set to
   * `'openrouter'` (or any string) when wrapping an OpenAI-compatible
   * client pointed at a different provider — keeps `llm.system` /
   * `gen_ai.system` distinguishable in dashboards.
   */
  system?: string;

  /**
   * Optional callback fired AFTER the span input attributes are stamped.
   * Lets a wrapper (e.g. OpenRouter) attach extra provider-specific tags
   * derived from the request body (model namespace, etc.).
   */
  onSpanStart?: (span: Span, body: OpenAIChatCompletionParams) => void;

  /**
   * Convention mode override. When unset, reads
   * `OTEL_SEMCONV_STABILITY_OPT_IN` (default `'dup'`).
   */
  conventionMode?: ConventionMode;
}

interface OpenAIChatCompletionParams {
  model:    string;
  messages: Array<Record<string, unknown>>;
  tools?:   Array<{ type: 'function'; function: { name: string; description?: string; parameters?: unknown } }>;
  stream?:  boolean;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  [k: string]: unknown;
}

interface OpenAIChatCompletionResponse {
  id?:     string;
  model?:  string;
  choices?: Array<{
    message?: {
      role?:       string;
      content?:    string | null;
      tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?:     number;
    completion_tokens?: number;
    total_tokens?:      number;
    prompt_tokens_details?:     { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

/**
 * OpenAI SDK shape: `{ chat: { completions: { create(...) } }, ... }`.
 * Type minimally to stay decoupled from the SDK's exact version.
 */
interface OpenAILike {
  chat: {
    completions: {
      create: (body: OpenAIChatCompletionParams, options?: unknown) => Promise<OpenAIChatCompletionResponse | unknown>;
    };
  };
  [k: string]: unknown;
}

/**
 * Adapt the legacy {@link InstrumentOptions.costPerToken} table to a
 * {@link PricingSource}. Per-token USD rates → per-million; OpenAI's
 * date-suffixed model IDs (`gpt-5.5-2026-04-23`) fall back to the
 * longest-prefix entry — matches the historical lookup behaviour.
 */
function pricingFromCostPerToken(
  table: Record<string, { input: number; output: number; cached?: number }>,
): PricingSource {
  // Pre-sort prefixes by length once for O(log) lookup amortisation
  // across many requests on the same instrumented client.
  const prefixes = Object.keys(table).sort((a, b) => b.length - a.length);
  return {
    lookup(model: string): ModelPricing | undefined {
      const exact = table[model];
      const entry = exact ?? table[prefixes.find(p => model.startsWith(p)) ?? ''];
      if (!entry) return undefined;
      const out: ModelPricing = {
        input:  entry.input  * 1_000_000,
        output: entry.output * 1_000_000,
      };
      if (entry.cached && entry.input > 0) {
        out.cache_read_multiplier = entry.cached / entry.input;
      }
      return out;
    },
  };
}

export function instrument<T extends OpenAILike>(client: T, opts: InstrumentOptions = {}): T {
  // Resolve the pricing source: explicit `pricing` wins; otherwise wrap
  // a legacy `costPerToken` table; otherwise undefined (cost is omitted
  // from spans but token counts still flow).
  const pricing: PricingSource | undefined =
    opts.pricing ?? (opts.costPerToken ? pricingFromCostPerToken(opts.costPerToken) : undefined);
  const system = opts.system ?? 'openai';
  const mode = resolveConventionMode(opts);

  const wrappedCompletions = new Proxy(client.chat.completions, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'create' || typeof value !== 'function') return value;

      return function wrappedCreate(this: unknown, body: OpenAIChatCompletionParams, options?: unknown) {
        // Streaming: pass through without instrumentation in v1.
        if (body?.stream === true) {
          return (value as Function).call(target, body, options);
        }

        const span = tracer.startSpan(`chat ${system} ${body.model ?? 'unknown'}`, {
          kind: OTelSpanKind.CLIENT,
        });

        try {
          stampInputAttributes(span, body, system, mode);
          opts.onSpanStart?.(span, body);
        } catch (err) {
          console.warn('[agent-otel/openai] input stamping failed:', err);
        }

        const promise = (value as Function).call(target, body, options) as Promise<OpenAIChatCompletionResponse>;

        return promise
          .then((resp) => {
            try {
              stampOutputAttributes(span, body, resp, pricing, mode);
              span.setStatus({ code: SpanStatusCode.OK });
            } catch (err) {
              console.warn('[agent-otel/openai] output stamping failed:', err);
            } finally {
              span.end();
            }
            return resp;
          })
          .catch((err: Error) => {
            try {
              span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
              span.recordException(err);
            } finally {
              span.end();
            }
            throw err;
          });
      };
    },
  });

  // Two layers of Proxy: client.chat returns a wrapped completions; the
  // top-level client returns a wrapped chat.
  const wrappedChat = new Proxy(client.chat, {
    get(target, prop, receiver) {
      if (prop === 'completions') return wrappedCompletions;
      return Reflect.get(target, prop, receiver);
    },
  });

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'chat') return wrappedChat;
      return Reflect.get(target, prop, receiver);
    },
  });
}

// ---------------------------------------------------------------------------
// Attribute stampers (OpenInference convention)
// ---------------------------------------------------------------------------

function stampInputAttributes(span: Span, body: OpenAIChatCompletionParams, system: string, mode: ConventionMode): void {
  setLLMFoundation(span, {
    provider: system,
    model: body.model,
    serverAddress: system === 'openai' ? 'api.openai.com' : undefined,
  }, mode);
  setLLMSampling(span, {
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    max_tokens:  typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens :
                 typeof body.max_tokens             === 'number' ? body.max_tokens             : undefined,
    top_p:       typeof body.top_p             === 'number' ? body.top_p             : undefined,
    frequency_penalty: typeof body.frequency_penalty === 'number' ? body.frequency_penalty : undefined,
    presence_penalty:  typeof body.presence_penalty  === 'number' ? body.presence_penalty  : undefined,
    seed:        typeof body.seed              === 'number' ? body.seed              : undefined,
    stop_sequences: Array.isArray(body.stop) ? (body.stop as string[]) :
                    typeof body.stop === 'string' ? [body.stop] : undefined,
    stream:      body.stream === true,
  }, mode);

  // Content stays OpenInference-flat for now — structured
  // `gen_ai.input.messages` lands when content emission moves to opt-in.
  // In `gen_ai`-only mode these flat attrs are skipped.
  if (!emitOpenInference(mode)) return;

  // Per-message input flattening (OpenInference layout)
  let idx = 0;
  for (const msg of body.messages ?? []) {
    const role = String(msg.role ?? 'user');
    const prefix = `llm.input_messages.${idx}.message`;
    span.setAttribute(`${prefix}.role`, role);

    const flat = flattenContent(msg.content);
    if (flat) span.setAttribute(`${prefix}.content`, truncate(flat, MAX_MESSAGE_CONTENT));

    // Tool calls within an assistant message
    if (Array.isArray(msg.tool_calls)) {
      let tcIdx = 0;
      for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
        const fn = tc.function as Record<string, unknown> | undefined;
        const tcPrefix = `${prefix}.tool_calls.${tcIdx}`;
        span.setAttribute(`${tcPrefix}.tool_call.id`, String(tc.id ?? ''));
        span.setAttribute(`${tcPrefix}.tool_call.function.name`, String(fn?.name ?? ''));
        span.setAttribute(`${tcPrefix}.tool_call.function.arguments`,
          truncate(String(fn?.arguments ?? ''), MAX_MESSAGE_CONTENT));
        tcIdx++;
      }
    }

    // tool-role messages carry `tool_call_id` and `name`
    if (role === 'tool') {
      if (typeof msg.tool_call_id === 'string') span.setAttribute(`${prefix}.tool_call_id`, msg.tool_call_id);
      if (typeof msg.name === 'string')         span.setAttribute(`${prefix}.name`,         msg.name);
    }
    idx++;
  }

  // Tool definitions (function-calling)
  if (body.tools?.length) {
    span.setAttribute('llm.tools.count', body.tools.length);
    body.tools.forEach((t, i) => {
      const fn = t.function;
      span.setAttribute(`llm.tools.${i}.tool.json_schema`,
        truncate(JSON.stringify({ name: fn.name, description: fn.description, parameters: fn.parameters }), MAX_TOOL_SCHEMA),
      );
    });
  }

  // Full request body for replay/forensics. Strip image/audio binary so
  // spans stay exportable.
  try {
    const stripped = {
      model:       body.model,
      messages:    (body.messages ?? []).map(stripBinaryFromMessage),
      tools:       body.tools,
      temperature: body.temperature,
      max_tokens:  body.max_tokens,
      max_completion_tokens: body.max_completion_tokens,
    };
    const raw = JSON.stringify(stripped);
    span.setAttribute('llm.request.body',       truncate(raw, MAX_RAW_REQUEST));
    span.setAttribute('llm.request.body_bytes', raw.length);
  } catch {
    // circular refs / bigint — skip raw body; flattened attrs already set
  }
}

function stampOutputAttributes(
  span: Span,
  body: OpenAIChatCompletionParams,
  resp: OpenAIChatCompletionResponse,
  pricing: PricingSource | undefined,
  mode: ConventionMode,
): void {
  const choice = resp.choices?.[0];
  if (!choice) return;

  setLLMResponse(span, {
    id: resp.id,
    model: resp.model,
    finishReasons: choice.finish_reason ? [choice.finish_reason] : undefined,
  }, mode);

  if (emitOpenInference(mode)) {
    span.setAttribute('llm.output_messages.0.message.role', choice.message?.role ?? 'assistant');

    const text = choice.message?.content;
    if (typeof text === 'string' && text) {
      span.setAttribute('llm.output_messages.0.message.content', truncate(text, MAX_MESSAGE_CONTENT));
    }

    if (choice.message?.tool_calls?.length) {
      let i = 0;
      for (const tc of choice.message.tool_calls) {
        const prefix = `llm.output_messages.0.message.tool_calls.${i}`;
        span.setAttribute(`${prefix}.tool_call.id`, tc.id);
        span.setAttribute(`${prefix}.tool_call.function.name`, tc.function.name);
        span.setAttribute(`${prefix}.tool_call.function.arguments`,
          truncate(tc.function.arguments ?? '', MAX_MESSAGE_CONTENT));
        i++;
      }
      span.setAttribute('llm.tool_calls.count', i);
    }

    if (resp.model) span.setAttribute('llm.response.model', resp.model);
  }

  // Token + cost attrs via the cost module. extractors.openai handles
  // the OpenAI-specific cached-subtraction (prompt_tokens is GROSS;
  // LLMUsage.input_tokens is the UNCACHED portion). recordLLMCall
  // dual-emits OpenInference + OTel-GenAI attribute names. When
  // `pricing` is undefined cost is simply omitted from the span;
  // token counts still flow.
  const usage = extractors.openai(resp.usage);
  const cost = pricing && body.model
    ? calculateCost(body.model, usage, pricing)
    : undefined;
  recordLLMCall(span, { usage, cost, conventionMode: mode });
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image_url') {
      const url = (block.image_url as Record<string, unknown> | undefined)?.url;
      parts.push(`[image: ${typeof url === 'string' ? url.slice(0, 60) : 'unknown'}]`);
    } else if (block.type === 'input_audio') {
      parts.push('[input_audio]');
    }
  }
  return parts.join('\n');
}

function stripBinaryFromMessage(msg: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(msg.content)) return msg;
  const stripped = (msg.content as Array<Record<string, unknown>>).map((block) => {
    if (block.type === 'image_url') {
      const url = (block.image_url as Record<string, unknown> | undefined)?.url;
      // Inline base64 images blow span size — replace with marker
      if (typeof url === 'string' && url.startsWith('data:')) {
        return { type: 'image_url', image_url: { url: `[stripped: ${url.length} char data url]` } };
      }
    }
    if (block.type === 'input_audio') {
      const audio = block.input_audio as Record<string, unknown> | undefined;
      const dataLen = typeof audio?.data === 'string' ? audio.data.length : 0;
      return { type: 'input_audio', input_audio: { ...audio, data: `[stripped: ${dataLen} base64 chars]` } };
    }
    return block;
  });
  return { ...msg, content: stripped };
}
