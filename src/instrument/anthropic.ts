/**
 * Auto-instrument the Anthropic SDK.
 *
 *   import Anthropic from '@anthropic-ai/sdk';
 *   import { instrument } from 'agent-otel/anthropic';
 *
 *   const client = instrument(new Anthropic({ apiKey: '...' }));
 *
 *   // Every messages.create() call now emits an OTel span with
 *   // OpenInference-shaped attributes — picked up by your Router
 *   // SpanProcessor automatically.
 *   const resp = await client.messages.create({ model: '...', messages: [...] });
 *
 * The wrapper is transparent: same call signature, same return type, same
 * thrown errors. The only side effect is span emission via the global
 * OTel tracer. If no SpanProcessor is registered, spans are dropped
 * (no-op tracer) — instrumentation costs zero in unconfigured environments.
 *
 * What gets emitted (OpenInference convention):
 *   span.name             = `chat anthropic <model>`
 *   span.kind             = CLIENT
 *   gen_ai.system         = 'anthropic'
 *   gen_ai.request.model  = body.model
 *   llm.model_name        = body.model              (alias)
 *   llm.system            = 'anthropic'             (alias)
 *   llm.input_messages.*  = flattened messages (OpenInference per-message attrs)
 *   llm.tools.*           = flattened tool definitions
 *   llm.request.body      = full JSON request (binary stripped, truncated 64KB)
 *   llm.token_count.*     = input/output/total + cache_read when present
 *   llm.cost.total        = best-effort USD cost (set when known per model)
 *   openinference.span.kind = 'LLM'
 *
 * On error: span status = ERROR, exception recorded.
 *
 * Streaming: detected via body.stream === true. v1 passes streaming
 * calls through WITHOUT instrumentation (better than not working) — full
 * stream-wrapping with progressive token attribution lands in v2.
 *
 * Cost calculation: pulls per-token rates from a small built-in table for
 * common Anthropic models. For models we don't know, cost is omitted from
 * the span (callers can compute from token counts if they need it). The
 * table is intentionally small to keep this module footprint-free; bring
 * your own costs via `instrument(client, { costPerToken: {...} })`.
 */

import { trace, SpanStatusCode, SpanKind as OTelSpanKind, type Span } from '@opentelemetry/api';

const tracer = trace.getTracer('agent-otel/anthropic', '0.0.11');

// Per-token costs in USD (input / output) for Anthropic models we know.
// Conservative defaults; `instrument(client, { costPerToken })` overrides.
const DEFAULT_COSTS_USD: Record<string, { input: number; output: number; cacheRead?: number }> = {
  'claude-opus-4-7':       { input: 15  / 1_000_000, output: 75   / 1_000_000, cacheRead: 1.5 / 1_000_000 },
  'claude-opus-4-6':       { input: 15  / 1_000_000, output: 75   / 1_000_000, cacheRead: 1.5 / 1_000_000 },
  'claude-sonnet-4-7':     { input: 3   / 1_000_000, output: 15   / 1_000_000, cacheRead: 0.3 / 1_000_000 },
  'claude-sonnet-4-6':     { input: 3   / 1_000_000, output: 15   / 1_000_000, cacheRead: 0.3 / 1_000_000 },
  'claude-haiku-4-5':      { input: 1   / 1_000_000, output: 5    / 1_000_000, cacheRead: 0.1 / 1_000_000 },
  'claude-3-5-sonnet':     { input: 3   / 1_000_000, output: 15   / 1_000_000 },
  'claude-3-5-haiku':      { input: 0.8 / 1_000_000, output: 4    / 1_000_000 },
};

const MAX_RAW_REQUEST = 64_000;
const MAX_MESSAGE_CONTENT = 16_000;
const MAX_SYSTEM_CONTENT = 32_000;
const MAX_TOOL_SCHEMA = 20_000;

function truncate(s: string, limit: number): string {
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `…[truncated ${s.length - limit} chars]`;
}

interface InstrumentOptions {
  /**
   * Override the per-token cost table. Keys are model names; values are
   * `{ input, output, cacheRead? }` in USD per token (NOT per million).
   * Use to handle custom-priced models or stay current with Anthropic's
   * pricing without waiting for an agent-otel release.
   */
  costPerToken?: Record<string, { input: number; output: number; cacheRead?: number }>;
}

interface AnthropicMessageCreateParams {
  model:    string;
  messages: Array<Record<string, unknown>>;
  system?:  string | Array<Record<string, unknown>>;
  tools?:   Array<{ name: string; description?: string; input_schema?: unknown }>;
  stream?:  boolean;
  max_tokens?: number;
  temperature?: number;
  [k: string]: unknown;
}

interface AnthropicMessageResponse {
  id?:      string;
  content?: Array<Record<string, unknown>>;
  usage?: {
    input_tokens?:              number;
    output_tokens?:             number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?:   number;
  };
  stop_reason?: string;
}

/**
 * Anthropic SDK has the shape `{ messages: { create(...) }, ... }`. We
 * type minimally to stay decoupled from the SDK's exact version.
 */
interface AnthropicLike {
  messages: {
    create: (body: AnthropicMessageCreateParams, options?: unknown) => Promise<AnthropicMessageResponse | unknown>;
  };
  [k: string]: unknown;
}

export function instrument<T extends AnthropicLike>(client: T, opts: InstrumentOptions = {}): T {
  const costs = { ...DEFAULT_COSTS_USD, ...(opts.costPerToken ?? {}) };

  const wrappedMessages = new Proxy(client.messages, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'create' || typeof value !== 'function') return value;

      // Wrap `create`. Bind to the original messages object so internal
      // SDK state (auth, transport) flows through.
      return function wrappedCreate(this: unknown, body: AnthropicMessageCreateParams, options?: unknown) {
        // Streaming: pass through without instrumentation. v2 will wrap
        // the returned Stream and emit progressive token spans.
        if (body?.stream === true) {
          return (value as Function).call(target, body, options);
        }

        const span = tracer.startSpan(`chat anthropic ${body.model ?? 'unknown'}`, {
          kind: OTelSpanKind.CLIENT,
        });

        try {
          stampInputAttributes(span, body);
        } catch (err) {
          // Never let instrumentation kill the request. Log and continue.
          console.warn('[agent-otel/anthropic] input stamping failed:', err);
        }

        const promise = (value as Function).call(target, body, options) as Promise<AnthropicMessageResponse>;

        return promise
          .then((resp) => {
            try {
              stampOutputAttributes(span, body, resp, costs);
              span.setStatus({ code: SpanStatusCode.OK });
            } catch (err) {
              console.warn('[agent-otel/anthropic] output stamping failed:', err);
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

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'messages') return wrappedMessages;
      return Reflect.get(target, prop, receiver);
    },
  });
}

// ---------------------------------------------------------------------------
// Attribute stampers (OpenInference convention)
// ---------------------------------------------------------------------------

function stampInputAttributes(span: Span, body: AnthropicMessageCreateParams): void {
  span.setAttribute('openinference.span.kind', 'LLM');
  span.setAttribute('gen_ai.system', 'anthropic');
  span.setAttribute('llm.system',    'anthropic');
  span.setAttribute('llm.provider',  'anthropic');
  if (body.model) {
    span.setAttribute('gen_ai.request.model', body.model);
    span.setAttribute('llm.model_name',       body.model);
  }
  if (typeof body.temperature === 'number') {
    span.setAttribute('llm.request.temperature', body.temperature);
  }
  if (typeof body.max_tokens === 'number') {
    span.setAttribute('llm.request.max_tokens', body.max_tokens);
  }

  // System prompt — Anthropic's body.system is string OR array of content blocks.
  const sysText = typeof body.system === 'string'
    ? body.system
    : Array.isArray(body.system)
      ? body.system.map((b: Record<string, unknown>) => typeof b.text === 'string' ? b.text : '').join('\n')
      : '';
  let idx = 0;
  if (sysText) {
    span.setAttribute(`llm.input_messages.${idx}.message.role`,    'system');
    span.setAttribute(`llm.input_messages.${idx}.message.content`, truncate(sysText, MAX_SYSTEM_CONTENT));
    idx++;
  }

  // Per-message input flattening (OpenInference layout)
  for (const msg of body.messages ?? []) {
    const role = String(msg.role ?? 'user');
    const prefix = `llm.input_messages.${idx}.message`;
    span.setAttribute(`${prefix}.role`, role);

    const content = msg.content;
    const flat = flattenContent(content);
    if (flat) span.setAttribute(`${prefix}.content`, truncate(flat, MAX_MESSAGE_CONTENT));

    // Tool calls within an assistant message
    if (Array.isArray(content)) {
      let tcIdx = 0;
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'tool_use') {
          const tcPrefix = `${prefix}.tool_calls.${tcIdx}`;
          span.setAttribute(`${tcPrefix}.tool_call.id`,                  String(block.id ?? ''));
          span.setAttribute(`${tcPrefix}.tool_call.function.name`,       String(block.name ?? ''));
          span.setAttribute(`${tcPrefix}.tool_call.function.arguments`,
            truncate(JSON.stringify(block.input ?? {}), MAX_MESSAGE_CONTENT));
          tcIdx++;
        }
      }
    }
    idx++;
  }

  // Tool definitions
  if (body.tools?.length) {
    span.setAttribute('llm.tools.count', body.tools.length);
    body.tools.forEach((t, i) => {
      span.setAttribute(`llm.tools.${i}.tool.json_schema`,
        truncate(JSON.stringify({ name: t.name, description: t.description, parameters: t.input_schema }), MAX_TOOL_SCHEMA),
      );
    });
  }

  // Full request body for replay/forensics. Strip binary blocks (large
  // base64 image/document data) so spans stay exportable.
  try {
    const stripped = {
      model:    body.model,
      system:   body.system,
      messages: (body.messages ?? []).map(stripBinaryFromMessage),
      tools:    body.tools,
      temperature: body.temperature,
      max_tokens:  body.max_tokens,
    };
    const raw = JSON.stringify(stripped);
    span.setAttribute('llm.request.body',       truncate(raw, MAX_RAW_REQUEST));
    span.setAttribute('llm.request.body_bytes', raw.length);
  } catch {
    // circular refs / bigint — skip raw body, individual attrs are still set
  }
}

function stampOutputAttributes(
  span: Span,
  body: AnthropicMessageCreateParams,
  resp: AnthropicMessageResponse,
  costs: Record<string, { input: number; output: number; cacheRead?: number }>,
): void {
  // Output assistant message
  span.setAttribute('llm.output_messages.0.message.role', 'assistant');

  let text = '';
  let toolCallCount = 0;
  for (const block of resp.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
    if (block.type === 'tool_use') {
      const prefix = `llm.output_messages.0.message.tool_calls.${toolCallCount}`;
      span.setAttribute(`${prefix}.tool_call.id`,                  String(block.id ?? ''));
      span.setAttribute(`${prefix}.tool_call.function.name`,       String(block.name ?? ''));
      span.setAttribute(`${prefix}.tool_call.function.arguments`,
        truncate(JSON.stringify(block.input ?? {}), MAX_MESSAGE_CONTENT));
      toolCallCount++;
    }
  }
  if (text) span.setAttribute('llm.output_messages.0.message.content', truncate(text, MAX_MESSAGE_CONTENT));
  if (toolCallCount > 0) span.setAttribute('llm.tool_calls.count', toolCallCount);
  if (resp.stop_reason) span.setAttribute('llm.response.stop_reason', resp.stop_reason);
  if (resp.id) span.setAttribute('llm.response.id', resp.id);

  // Token counts
  const u = resp.usage ?? {};
  if (typeof u.input_tokens === 'number') {
    span.setAttribute('llm.token_count.prompt', u.input_tokens);
  }
  if (typeof u.output_tokens === 'number') {
    span.setAttribute('llm.token_count.completion', u.output_tokens);
  }
  if (typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number') {
    span.setAttribute('llm.token_count.total', u.input_tokens + u.output_tokens);
  }
  if (typeof u.cache_read_input_tokens === 'number' && u.cache_read_input_tokens > 0) {
    span.setAttribute('llm.token_count.prompt_details.cache_read', u.cache_read_input_tokens);
  }
  if (typeof u.cache_creation_input_tokens === 'number' && u.cache_creation_input_tokens > 0) {
    span.setAttribute('llm.token_count.prompt_details.cache_write', u.cache_creation_input_tokens);
  }

  // Cost (best-effort)
  const rate = body.model ? costs[body.model] : undefined;
  if (rate) {
    const promptCost = (u.input_tokens ?? 0) * rate.input;
    const cacheCost  = rate.cacheRead && u.cache_read_input_tokens
      ? u.cache_read_input_tokens * rate.cacheRead
      : 0;
    const completionCost = (u.output_tokens ?? 0) * rate.output;
    const total = promptCost + cacheCost + completionCost;
    span.setAttribute('llm.cost.total', Number(total.toFixed(8)));
  }
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image')    parts.push(`[image: ${block.media_type ?? 'unknown'}]`);
    else if (block.type === 'document') parts.push(`[document: ${block.media_type ?? 'unknown'}]`);
    else if (block.type === 'tool_result') {
      // tool_result blocks have content that's itself string-or-array
      const inner = flattenContent(block.content);
      if (inner) parts.push(`[tool_result ${block.tool_use_id ?? ''}: ${inner}]`);
    }
  }
  return parts.join('\n');
}

function stripBinaryFromMessage(msg: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(msg.content)) return msg;
  const stripped = (msg.content as Array<Record<string, unknown>>).map((block) => {
    if (block.type === 'image' || block.type === 'document') {
      const src = block.source as Record<string, unknown> | undefined;
      const dataLen = typeof src?.data === 'string' ? src.data.length : 0;
      return { type: block.type, source: { ...src, data: `[stripped: ${dataLen} base64 chars]` } };
    }
    return block;
  });
  return { ...msg, content: stripped };
}
