/**
 * Phoenix sink.
 *
 * Phoenix (https://phoenix.arize.com) accepts standard OTLP/HTTP at
 * `/v1/traces`. This sink is a thin wrapper around the generic `otlp` sink
 * with Phoenix-specific defaults: smart endpoint, optional API key header,
 * sensible batch sizes for Phoenix's ingest characteristics.
 *
 * Usage:
 *   import { phoenix } from '@daslab/agent-otel/sinks/phoenix';
 *
 *   const sink = phoenix({
 *     endpoint: 'http://localhost:6006',          // or https://app.phoenix.arize.com
 *     apiKey:   process.env.PHOENIX_API_KEY,      // omit for self-hosted no-auth
 *   });
 */

import type { Sink } from '../types.js';
import { otlp, type OtlpSinkOptions } from './otlp.js';

export interface PhoenixSinkOptions {
  /**
   * Base Phoenix URL. The sink appends `/v1/traces`.
   * Default: process.env.PHOENIX_ENDPOINT, or http://localhost:6006
   */
  endpoint?: string;
  /** Phoenix API key. Sent as `api_key` header. Omit for unsecured self-hosted. */
  apiKey?: string;
  /** Override sink name (default: 'phoenix'). */
  name?: string;
  /** Pass-through OTLP tuning. */
  batchSize?: OtlpSinkOptions['batchSize'];
  flushIntervalMs?: OtlpSinkOptions['flushIntervalMs'];
}

export function phoenix(opts: PhoenixSinkOptions = {}): Sink {
  const base = (opts.endpoint ?? process.env.PHOENIX_ENDPOINT ?? 'http://localhost:6006').replace(/\/$/, '');
  const headers: Record<string, string> = {};
  if (opts.apiKey) headers['api_key'] = opts.apiKey;

  return otlp({
    url: `${base}/v1/traces`,
    headers,
    name: opts.name ?? 'phoenix',
    batchSize: opts.batchSize ?? 50,
    flushIntervalMs: opts.flushIntervalMs ?? 2000,
  });
}
