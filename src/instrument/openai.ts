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

const tracer = trace.getTracer('agent-otel/openai', '0.0.12');

// Per-token costs in USD (input / output) for OpenAI models we know.
// Pricing is best-effort and goes stale — override via instrument({ costPerToken }).
// Values in USD per token (NOT per million); divide the published $/M number by 1M.
const DEFAULT_COSTS_USD: Record<string, { input: number; output: number; cached?: number }> = {
  // GPT-5.5 family (2026)
  'gpt-5.5':            { input: 5    / 1_000_000, output: 25   / 1_000_000, cached: 0.5  / 1_000_000 },
  'gpt-5.5-pro':        { input: 15   / 1_000_000, output: 75   / 1_000_000, cached: 1.5  / 1_000_000 },
  // GPT-5 family (2025)
  'gpt-5':              { input: 1.25 / 1_000_000, output: 10   / 1_000_000, cached: 0.125 / 1_000_000 },
  'gpt-5-mini':         { input: 0.25 / 1_000_000, output: 2    / 1_000_000, cached: 0.025 / 1_000_000 },
  'gpt-5-nano':         { input: 0.05 / 1_000_000, output: 0.4  / 1_000_000, cached: 0.005 / 1_000_000 },
  'gpt-5-pro':          { input: 15   / 1_000_000, output: 60   / 1_000_000, cached: 1.5  / 1_000_000 },
  // GPT-4.1 family (2025)
  'gpt-4.1':            { input: 2    / 1_000_000, output: 8    / 1_000_000, cached: 0.5  / 1_000_000 },
  'gpt-4.1-mini':       { input: 0.4  / 1_000_000, output: 1.6  / 1_000_000, cached: 0.1  / 1_000_000 },
  'gpt-4.1-nano':       { input: 0.1  / 1_000_000, output: 0.4  / 1_000_000, cached: 0.025 / 1_000_000 },
  // GPT-4o family
  'gpt-4o':             { input: 2.5  / 1_000_000, output: 10   / 1_000_000, cached: 1.25 / 1_000_000 },
  'gpt-4o-mini':        { input: 0.15 / 1_000_000, output: 0.6  / 1_000_000, cached: 0.075 / 1_000_000 },
};

const MAX_RAW_REQUEST = 64_000;
const MAX_MESSAGE_CONTENT = 16_000;
const MAX_TOOL_SCHEMA = 20_000;

function truncate(s: string, limit: number): string {
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `…[truncated ${s.length - limit} chars]`;
}

interface InstrumentOptions {
  /**
   * Override the per-token cost table. Keys are model names (or model
   * prefixes that startsWith match — `gpt-5.5` matches `gpt-5.5-2026-04-23`).
   * Values are `{ input, output, cached? }` in USD per token.
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

export function instrument<T extends OpenAILike>(client: T, opts: InstrumentOptions = {}): T {
  const costs = { ...DEFAULT_COSTS_USD, ...(opts.costPerToken ?? {}) };
  const system = opts.system ?? 'openai';

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
          stampInputAttributes(span, body, system);
          opts.onSpanStart?.(span, body);
        } catch (err) {
          console.warn('[agent-otel/openai] input stamping failed:', err);
        }

        const promise = (value as Function).call(target, body, options) as Promise<OpenAIChatCompletionResponse>;

        return promise
          .then((resp) => {
            try {
              stampOutputAttributes(span, body, resp, costs);
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

function stampInputAttributes(span: Span, body: OpenAIChatCompletionParams, system: string = 'openai'): void {
  span.setAttribute('openinference.span.kind', 'LLM');
  span.setAttribute('gen_ai.system', system);
  span.setAttribute('llm.system',    system);
  span.setAttribute('llm.provider',  system);
  if (body.model) {
    span.setAttribute('gen_ai.request.model', body.model);
    span.setAttribute('llm.model_name',       body.model);
  }
  if (typeof body.temperature === 'number') {
    span.setAttribute('llm.request.temperature', body.temperature);
  }
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (typeof maxTokens === 'number') {
    span.setAttribute('llm.request.max_tokens', maxTokens);
  }

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
  costs: Record<string, { input: number; output: number; cached?: number }>,
): void {
  const choice = resp.choices?.[0];
  if (!choice) return;
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

  if (choice.finish_reason) span.setAttribute('llm.response.stop_reason', choice.finish_reason);
  if (resp.id)              span.setAttribute('llm.response.id',          resp.id);
  if (resp.model)           span.setAttribute('llm.response.model',       resp.model);

  // Token counts
  const u = resp.usage ?? {};
  if (typeof u.prompt_tokens     === 'number') span.setAttribute('llm.token_count.prompt',     u.prompt_tokens);
  if (typeof u.completion_tokens === 'number') span.setAttribute('llm.token_count.completion', u.completion_tokens);
  if (typeof u.total_tokens      === 'number') span.setAttribute('llm.token_count.total',      u.total_tokens);
  const cached    = u.prompt_tokens_details?.cached_tokens;
  const reasoning = u.completion_tokens_details?.reasoning_tokens;
  if (typeof cached    === 'number' && cached    > 0) span.setAttribute('llm.token_count.prompt_details.cache_read', cached);
  if (typeof reasoning === 'number' && reasoning > 0) span.setAttribute('llm.token_count.completion_details.reasoning', reasoning);

  // Cost (best-effort; longest-prefix match so dated suffixes hit the base entry)
  const rate = body.model ? lookupCost(body.model, costs) : undefined;
  if (rate) {
    const promptCost     = (u.prompt_tokens ?? 0) * rate.input;
    const cachedCost     = rate.cached && cached ? cached * rate.cached : 0;
    const completionCost = (u.completion_tokens ?? 0) * rate.output;
    const total = promptCost + cachedCost + completionCost;
    span.setAttribute('llm.cost.total', Number(total.toFixed(8)));
  }
}

/**
 * OpenAI ships date-suffixed model IDs (`gpt-5.5-2026-04-23`). Match the
 * longest prefix in our cost table so a date-pinned id falls back to its
 * base model price. Override exact ids by passing `costPerToken` on
 * `instrument()`.
 */
function lookupCost(
  model: string,
  costs: Record<string, { input: number; output: number; cached?: number }>,
): { input: number; output: number; cached?: number } | undefined {
  if (costs[model]) return costs[model];
  const prefixes = Object.keys(costs).sort((a, b) => b.length - a.length);
  for (const p of prefixes) {
    if (model.startsWith(p)) return costs[p];
  }
  return undefined;
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
