/**
 * Counterfactual replay — re-execute a stored LLM call with one thing
 * swapped, against the real LLM provider, to see what the agent would
 * have done differently.
 *
 * This is flavor 3 from `replay.ts`'s docstring (counterfactual). The
 * generic `replay` module handles re-routing and data-only mutation;
 * this module handles real re-execution: stored span → reconstruct
 * provider request → apply a mutator → call the LLM → return new
 * response, optionally as a new span.
 *
 * Use case: "Would my agent have made a different tool call if I'd
 * used Sonnet 4.7 instead of 4.6?" Real answer, real new response,
 * real (small) cost.
 *
 * Provider support: Anthropic via `@anthropic-ai/sdk` lazy-imported as
 * an optional peer dep. For OpenAI, Gemini, etc. supply your own
 * `execute` function — agent-otel doesn't bundle every SDK.
 *
 * Costs real money. Each `replayLLMCall` makes a live LLM API call.
 * We surface input/output token counts and (when possible) cost in the
 * result. Use `dryRun: true` to apply the mutator and return the
 * mutated request without calling the provider.
 *
 * Usage:
 *   import { replayLLMCall, swapModel } from 'agent-otel/replay-execute';
 *
 *   const result = await replayLLMCall({
 *     source: postgresInspectable,        // or memory, etc.
 *     spanId: '0123abcd...',
 *     mutate: swapModel('claude-sonnet-4-7'),
 *     provider: 'anthropic',
 *     apiKey: process.env.ANTHROPIC_API_KEY!,
 *   });
 *
 *   console.log(result.original.attributes['llm.output_messages.0.message.content']);
 *   console.log(result.newResponse.content);
 */

import type { Inspectable, RoutedSpan } from './types.js';

// ============================================================================
// Provider-agnostic request shape
// ============================================================================

/**
 * Provider-shaped LLM request — usually a JSON object matching the
 * provider's API. We don't enforce a schema because the format differs
 * per provider; reconstruction copies the JSON verbatim from the stored
 * span's `llm.request.body` attribute.
 *
 * Mutators operate on this object. Built-in mutators (`swapModel`,
 * `setTemperature`, etc.) target keys that are common across providers.
 * For provider-specific mutations, write a custom mutator.
 */
export type LLMRequest = Record<string, unknown>;

export type RequestMutator = (req: LLMRequest) => LLMRequest;

/** Provider-shaped LLM response. */
export interface LLMResponse {
  content?:    string;
  toolCalls?:  Array<{ id: string; tool: string; input: unknown }>;
  tokens?:     { input?: number; output?: number; total?: number; reasoning?: number; cache_read?: number };
  cost?:       number;      // USD; provider-specific best-effort
  /** Raw response object for advanced inspection. */
  raw:         unknown;
}

/** User-supplied execute function (for non-built-in providers). */
export type ExecuteLLMRequest = (req: LLMRequest) => Promise<LLMResponse>;

// ============================================================================
// Built-in mutators
// ============================================================================

/** Swap the model. Works for Anthropic, OpenAI, Gemini — all use `model`. */
export function swapModel(newModel: string): RequestMutator {
  return (req) => ({ ...req, model: newModel });
}

/** Replace the system prompt. Provider-specific:
 *  - Anthropic uses a top-level `system: string`
 *  - OpenAI puts system in `messages[0]` with role='system' */
export function swapSystem(newSystem: string, opts?: { provider?: 'anthropic' | 'openai' }): RequestMutator {
  return (req) => {
    const provider = opts?.provider ?? detectProvider(req);
    if (provider === 'openai') {
      const msgs = Array.isArray(req.messages) ? [...req.messages as Array<Record<string, unknown>>] : [];
      const sysIdx = msgs.findIndex(m => m.role === 'system');
      const sysMsg = { role: 'system', content: newSystem };
      if (sysIdx >= 0) msgs[sysIdx] = sysMsg;
      else msgs.unshift(sysMsg);
      return { ...req, messages: msgs };
    }
    // Anthropic-shaped (default)
    return { ...req, system: newSystem };
  };
}

/** Set generation temperature. Common across providers. */
export function setTemperature(t: number): RequestMutator {
  return (req) => ({ ...req, temperature: t });
}

/** Append a message to the conversation. Useful for "what if the user said X next?" */
export function appendMessage(msg: { role: 'user' | 'assistant' | 'tool'; content: unknown }): RequestMutator {
  return (req) => {
    const msgs = Array.isArray(req.messages) ? [...req.messages as unknown[], msg] : [msg];
    return { ...req, messages: msgs };
  };
}

/** Compose multiple mutators into one. */
export function pipe(...mutators: RequestMutator[]): RequestMutator {
  return (req) => mutators.reduce((acc, m) => m(acc), req);
}

function detectProvider(req: LLMRequest): 'anthropic' | 'openai' | 'unknown' {
  // Heuristic: Anthropic has top-level `system: string`; OpenAI puts system in messages[0].
  if (typeof req.system === 'string') return 'anthropic';
  const messages = req.messages;
  if (Array.isArray(messages) && messages[0] && (messages[0] as Record<string, unknown>).role === 'system') {
    return 'openai';
  }
  return 'unknown';
}

// ============================================================================
// Built-in provider executors
// ============================================================================

/**
 * Execute against Anthropic's Messages API. Lazy-imports `@anthropic-ai/sdk`
 * (optional peer dep — install only if you use this provider helper).
 */
export async function executeAnthropic(
  req: LLMRequest,
  opts: { apiKey: string },
): Promise<LLMResponse> {
  let mod: typeof import('@anthropic-ai/sdk');
  try {
    mod = await import('@anthropic-ai/sdk');
  } catch {
    throw new Error(
      "[agent-otel/replay-execute] using provider='anthropic' requires the optional peer dep @anthropic-ai/sdk. Install it explicitly: bun add @anthropic-ai/sdk",
    );
  }
  const Anthropic = mod.default;
  const client = new Anthropic({ apiKey: opts.apiKey });

  // Anthropic requires max_tokens. Fall back to a sensible default if the
  // stored span didn't capture it (truncation, older instrumentation).
  const finalReq = { max_tokens: 4096, ...req } as Parameters<typeof client.messages.create>[0];

  const resp = await client.messages.create(finalReq) as { content?: Array<Record<string, unknown>>; usage?: Record<string, number> };
  return parseAnthropicResponse(resp);
}

function parseAnthropicResponse(resp: { content?: Array<Record<string, unknown>>; usage?: Record<string, number> }): LLMResponse {
  let text = '';
  const toolCalls: LLMResponse['toolCalls'] = [];
  for (const block of resp.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
    if (block.type === 'tool_use') {
      toolCalls.push({
        id:    String(block.id ?? ''),
        tool:  String(block.name ?? ''),
        input: block.input,
      });
    }
  }
  const u = resp.usage ?? {};
  return {
    content:   text || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    tokens: {
      input:      u.input_tokens,
      output:     u.output_tokens,
      total:      (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
      cache_read: u.cache_read_input_tokens,
    },
    raw: resp,
  };
}

// ============================================================================
// Request reconstruction from a stored span
// ============================================================================

/**
 * Pull the original LLM request out of a stored span. Three sources, in
 * priority order:
 *   1. `llm.request.body` JSON blob (best — full payload)
 *   2. Reassemble from individual `llm.input_messages.*` + `llm.tools.*`
 *      attributes (fallback for spans without the raw body)
 *   3. Throw — span doesn't have enough to reconstruct
 *
 * This is provider-agnostic: the reconstructed object is shaped like
 * whatever the agent originally sent. The mutator + executor pair
 * decides how to handle it.
 */
export function reconstructRequest(span: RoutedSpan): LLMRequest {
  const body = span.attributes['llm.request.body'];
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body) as LLMRequest;
      // Ensure model is set — usually not in the body, but in the top-level attr.
      if (!parsed.model && span.attributes['llm.model_name']) {
        parsed.model = span.attributes['llm.model_name'] as string;
      }
      return parsed;
    } catch (err) {
      throw new Error(`[agent-otel/replay-execute] llm.request.body on span ${span.spanId} is not valid JSON: ${(err as Error).message}`);
    }
  }

  // Fallback: rebuild from flattened attributes. Best-effort for older spans
  // that didn't capture the raw body.
  const messages: Array<{ role: string; content: unknown }> = [];
  for (let i = 0; i < 1000; i++) {
    const role    = span.attributes[`llm.input_messages.${i}.message.role`];
    const content = span.attributes[`llm.input_messages.${i}.message.content`];
    if (role === undefined && content === undefined) break;
    if (role !== undefined) messages.push({ role: String(role), content });
  }
  if (messages.length === 0) {
    throw new Error(`[agent-otel/replay-execute] span ${span.spanId} has no llm.request.body and no llm.input_messages.* attributes — cannot reconstruct request`);
  }
  return {
    model:    span.attributes['llm.model_name'],
    messages,
  };
}

// ============================================================================
// Top-level replay function
// ============================================================================

export interface CounterfactualReplayOptions {
  source:   Inspectable;
  spanId:   string;
  /** Single mutator or array (composed left-to-right). */
  mutate:   RequestMutator | RequestMutator[];
  /**
   * Built-in provider shortcut. Lazy-loads the SDK. Mutually exclusive
   * with `execute`.
   */
  provider?: 'anthropic';
  apiKey?:   string;
  /**
   * User-supplied executor. Takes precedence over `provider` if both
   * are set. Use this for OpenAI, Gemini, custom proxies, etc.
   */
  execute?:  ExecuteLLMRequest;
  /**
   * Skip the live LLM call. Returns the mutated request for inspection;
   * `newResponse` is undefined.
   */
  dryRun?:   boolean;
}

export interface CounterfactualReplayResult {
  /** The original stored span. */
  originalSpan:    RoutedSpan;
  /** The reconstructed original request (pre-mutation). */
  originalRequest: LLMRequest;
  /** The mutated request that was sent to the live LLM provider. */
  mutatedRequest:  LLMRequest;
  /** New response from the live call. Undefined when `dryRun: true`. */
  newResponse?:    LLMResponse;
  /** Wall-clock time spent in the live LLM call. */
  durationMs:      number;
}

/**
 * Replay a single LLM call counterfactually — fetch the stored span,
 * reconstruct the request, apply mutator(s), execute against the real
 * provider, return both original and new response for comparison.
 */
export async function replayLLMCall(opts: CounterfactualReplayOptions): Promise<CounterfactualReplayResult> {
  const span = await opts.source.getSpan(opts.spanId);
  if (!span) {
    throw new Error(`[agent-otel/replay-execute] span ${opts.spanId} not found in source`);
  }

  const originalRequest = reconstructRequest(span);

  const mutators = Array.isArray(opts.mutate) ? opts.mutate : [opts.mutate];
  const mutatedRequest = mutators.reduce((acc, m) => m(acc), originalRequest);

  if (opts.dryRun) {
    return {
      originalSpan:    span,
      originalRequest,
      mutatedRequest,
      newResponse:     undefined,
      durationMs:      0,
    };
  }

  // Pick executor
  let exec: ExecuteLLMRequest;
  if (opts.execute) {
    exec = opts.execute;
  } else if (opts.provider === 'anthropic') {
    if (!opts.apiKey) throw new Error("[agent-otel/replay-execute] provider='anthropic' requires apiKey");
    exec = (req) => executeAnthropic(req, { apiKey: opts.apiKey! });
  } else {
    throw new Error("[agent-otel/replay-execute] supply either `execute` or `provider`+`apiKey`");
  }

  const t0 = Date.now();
  const newResponse = await exec(mutatedRequest);
  const durationMs = Date.now() - t0;

  return {
    originalSpan:    span,
    originalRequest,
    mutatedRequest,
    newResponse,
    durationMs,
  };
}
