/**
 * Auto-instrument OpenRouter.
 *
 * OpenRouter speaks the OpenAI Chat Completions API verbatim — same SDK,
 * same endpoint shape, just a different base URL. This module is a thin
 * wrapper around `agent-otel/openai`'s instrument that:
 *   1. Defaults `baseURL` to `https://openrouter.ai/api/v1` when you ask
 *      for a fresh client via `client(...)`.
 *   2. Tags spans with `llm.system = 'openrouter'` (overriding the default
 *      `'openai'` tag the OpenAI instrument emits) so dashboards can tell
 *      OpenRouter traffic apart from direct OpenAI calls.
 *   3. Surfaces `llm.provider` from the model id prefix when known
 *      (e.g. `anthropic/claude-sonnet-4-7` → `'anthropic'`).
 *
 * Two ways to use:
 *
 *   import { client } from 'agent-otel/openrouter';
 *   const c = client({ apiKey: process.env.OPENROUTER_API_KEY! });
 *   await c.chat.completions.create({ model: 'anthropic/claude-sonnet-4-7', messages: [...] });
 *
 * Or wrap an existing OpenAI client you already configured for OpenRouter:
 *
 *   import OpenAI from 'openai';
 *   import { instrument } from 'agent-otel/openrouter';
 *
 *   const c = instrument(new OpenAI({
 *     apiKey:  process.env.OPENROUTER_API_KEY!,
 *     baseURL: 'https://openrouter.ai/api/v1',
 *   }));
 */

import { instrument as instrumentOpenAI } from './openai.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

interface OpenAILike {
  chat: { completions: { create: (...args: unknown[]) => Promise<unknown> } };
  [k: string]: unknown;
}

interface InstrumentOptions {
  costPerToken?: Record<string, { input: number; output: number; cached?: number }>;
}

/**
 * Wrap an OpenAI-shaped client for OpenRouter. Delegates to the OpenAI
 * instrument with `system: 'openrouter'` and an `onSpanStart` hook that
 * surfaces the underlying vendor (from the model id prefix) as
 * `llm.provider` — so an `anthropic/claude-sonnet-4-7` call lands with
 * `llm.system='openrouter'` and `llm.provider='anthropic'`.
 */
export function instrument<T extends OpenAILike>(client: T, opts: InstrumentOptions = {}): T {
  return instrumentOpenAI(client, {
    ...opts,
    system: 'openrouter',
    onSpanStart: (span, body) => {
      // OpenRouter model ids look like `vendor/model`. Surface the
      // underlying vendor as llm.provider (overrides the openai default's
      // 'openrouter' value), and keep the full id under a namespaced attr.
      if (typeof body?.model === 'string' && body.model.includes('/')) {
        const vendor = body.model.split('/')[0]!;
        span.setAttribute('llm.provider', vendor);
        span.setAttribute('llm.openrouter.model', body.model);
      }
    },
  });
}

/**
 * Construct an OpenRouter-configured + instrumented client in one call.
 * Lazy-imports `openai` (optional peer dep — install if you want this
 * helper).
 *
 *   const c = client({ apiKey: process.env.OPENROUTER_API_KEY! });
 *   await c.chat.completions.create({ model: 'anthropic/claude-sonnet-4-7', ... });
 *
 * If you already construct your OpenAI client with custom retry / fetch
 * config, use `instrument(yourClient)` directly instead.
 */
export async function client(opts: {
  apiKey: string;
  baseURL?: string;
  /** Optional title / referer headers OpenRouter uses for analytics. */
  appTitle?: string;
  appUrl?: string;
  /** Pass-through cost overrides. */
  costPerToken?: InstrumentOptions['costPerToken'];
}): Promise<OpenAILike> {
  let mod: typeof import('openai');
  try {
    mod = await import('openai');
  } catch {
    throw new Error(
      "[agent-otel/openrouter] `openai` package is required. Install it: bun add openai",
    );
  }
  const OpenAI = mod.default;

  const defaultHeaders: Record<string, string> = {};
  if (opts.appTitle) defaultHeaders['X-Title'] = opts.appTitle;
  if (opts.appUrl)   defaultHeaders['HTTP-Referer'] = opts.appUrl;

  const c = new OpenAI({
    apiKey:  opts.apiKey,
    baseURL: opts.baseURL ?? OPENROUTER_BASE_URL,
    defaultHeaders: Object.keys(defaultHeaders).length > 0 ? defaultHeaders : undefined,
  });

  return instrument(c as unknown as OpenAILike, { costPerToken: opts.costPerToken });
}
