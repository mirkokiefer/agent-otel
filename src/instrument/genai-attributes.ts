/**
 * Shared attribute helpers for LLM-call spans. Mode-aware: each helper
 * checks the {@link ConventionMode} and writes OpenInference, OTel-GenAI,
 * or both. Single source of truth — instrumentations call these instead
 * of `span.setAttribute(...)` directly.
 *
 * Token + cost attributes live in `../cost/record.ts` (`recordLLMCall`)
 * — same mode awareness, different scope.
 */

import type { Span } from '@opentelemetry/api';
import { emitGenAI, emitOpenInference, type ConventionMode } from './convention.js';

/**
 * Foundational attributes set when an LLM span is created. Identifies
 * the call's provider, model, and operation type.
 */
export interface LLMFoundationOpts {
  provider: string;          // 'anthropic' | 'openai' | 'gcp.vertex_ai' | ...
  model:    string | undefined;
  /** Hostname of the upstream API. Stable OTel attribute when set. */
  serverAddress?: string;
}

export function setLLMFoundation(span: Span, opts: LLMFoundationOpts, mode: ConventionMode): void {
  if (emitOpenInference(mode)) {
    span.setAttribute('openinference.span.kind', 'LLM');
    span.setAttribute('llm.system',   opts.provider);
    span.setAttribute('llm.provider', opts.provider);
    if (opts.model) span.setAttribute('llm.model_name', opts.model);
  }
  if (emitGenAI(mode)) {
    span.setAttribute('gen_ai.operation.name', 'chat');
    span.setAttribute('gen_ai.provider.name',  opts.provider);
    // `gen_ai.system` is the deprecated predecessor of `gen_ai.provider.name`
    // — keep emitting both during the spec transition window.
    span.setAttribute('gen_ai.system',         opts.provider);
    if (opts.model) span.setAttribute('gen_ai.request.model', opts.model);
  }
  // `server.address` is a STABLE OTel attribute (not GenAI-specific) —
  // emit unconditionally when known so APM tooling can group by endpoint.
  if (opts.serverAddress) span.setAttribute('server.address', opts.serverAddress);
}

/**
 * Sampling parameters. Some providers expose only a subset; pass
 * `undefined` for any the provider doesn't surface and they're skipped.
 */
export interface LLMSamplingParams {
  temperature?:       number;
  top_p?:             number;
  top_k?:             number;
  max_tokens?:        number;
  frequency_penalty?: number;
  presence_penalty?:  number;
  stop_sequences?:    string[];
  seed?:              number;
  stream?:            boolean;
}

export function setLLMSampling(span: Span, params: LLMSamplingParams, mode: ConventionMode): void {
  const oi    = emitOpenInference(mode);
  const genai = emitGenAI(mode);

  if (typeof params.temperature === 'number') {
    if (oi)    span.setAttribute('llm.request.temperature',     params.temperature);
    if (genai) span.setAttribute('gen_ai.request.temperature',  params.temperature);
  }
  if (typeof params.top_p === 'number') {
    if (oi)    span.setAttribute('llm.request.top_p',     params.top_p);
    if (genai) span.setAttribute('gen_ai.request.top_p',  params.top_p);
  }
  if (typeof params.top_k === 'number') {
    if (genai) span.setAttribute('gen_ai.request.top_k',  params.top_k);
  }
  if (typeof params.max_tokens === 'number') {
    if (oi)    span.setAttribute('llm.request.max_tokens',    params.max_tokens);
    if (genai) span.setAttribute('gen_ai.request.max_tokens', params.max_tokens);
  }
  if (typeof params.frequency_penalty === 'number') {
    if (genai) span.setAttribute('gen_ai.request.frequency_penalty', params.frequency_penalty);
  }
  if (typeof params.presence_penalty === 'number') {
    if (genai) span.setAttribute('gen_ai.request.presence_penalty', params.presence_penalty);
  }
  if (Array.isArray(params.stop_sequences) && params.stop_sequences.length > 0) {
    if (genai) span.setAttribute('gen_ai.request.stop_sequences', params.stop_sequences);
  }
  if (typeof params.seed === 'number') {
    if (genai) span.setAttribute('gen_ai.request.seed', params.seed);
  }
  if (typeof params.stream === 'boolean') {
    if (genai) span.setAttribute('gen_ai.request.stream', params.stream);
  }
}

/**
 * Response-side attributes. `finishReasons` is OTel-GenAI's plural,
 * mirrored back to OpenInference's singular `llm.response.stop_reason`
 * as the first element.
 */
export interface LLMResponseAttrs {
  id?:            string;
  /** Actual model the API returned (sometimes differs from request). */
  model?:         string;
  finishReasons?: string[];
  /** For streaming responses — ms from request start to first chunk. */
  timeToFirstChunkMs?: number;
}

export function setLLMResponse(span: Span, resp: LLMResponseAttrs, mode: ConventionMode): void {
  const oi    = emitOpenInference(mode);
  const genai = emitGenAI(mode);

  if (resp.id) {
    if (oi)    span.setAttribute('llm.response.id',    resp.id);
    if (genai) span.setAttribute('gen_ai.response.id', resp.id);
  }
  if (resp.model && genai) {
    span.setAttribute('gen_ai.response.model', resp.model);
  }
  if (resp.finishReasons?.length) {
    if (oi)    span.setAttribute('llm.response.stop_reason',      resp.finishReasons[0]);
    if (genai) span.setAttribute('gen_ai.response.finish_reasons', resp.finishReasons);
  }
  if (typeof resp.timeToFirstChunkMs === 'number' && genai) {
    span.setAttribute('gen_ai.response.time_to_first_chunk', resp.timeToFirstChunkMs / 1000); // spec wants seconds
  }
}

/**
 * Resource attributes published once per process via the OTel SDK
 * resource. Lets consumers introspect which convention versions
 * agent-otel emits without sniffing individual spans.
 */
export const RESOURCE_VERSION_ATTRS = {
  'agent_otel.openinference.version': '1.x',
  'agent_otel.gen_ai.version':        '1.40',
} as const;
