/**
 * Braintrust sink.
 *
 * Braintrust (https://braintrust.dev) accepts OTel spans at their OTLP
 * endpoint and maps them into Logs / Experiments based on header context.
 * This sink wraps the generic OTLP sink with Braintrust-specific defaults
 * and the `x-bt-parent` header for project routing.
 *
 * Endpoint reference (as of 2026-04):
 *   https://api.braintrust.dev/otel/v1/traces
 *
 * Usage:
 *   import { braintrust } from '@daslab/agent-otel/sinks/braintrust';
 *
 *   const sink = braintrust({
 *     apiKey:  process.env.BRAINTRUST_API_KEY!,
 *     project: 'support-agent',
 *   });
 */

import type { Sink } from '../types.js';
import { otlp, type OtlpSinkOptions } from './otlp.js';

export interface BraintrustSinkOptions {
  /** Braintrust API key. Required. */
  apiKey: string;
  /**
   * Routing target inside Braintrust. Spans land in this project's logs.
   * For experiment runs, use `experiment` instead.
   */
  project?: string;
  /**
   * Send spans into a specific experiment instead of logs. Mutually
   * exclusive with `project` — Braintrust uses one or the other via the
   * `x-bt-parent` header.
   */
  experiment?: string;
  /** Override default API URL (https://api.braintrust.dev). */
  endpoint?: string;
  /** Override sink name (default: 'braintrust'). */
  name?: string;
  /** Pass-through OTLP tuning. */
  batchSize?: OtlpSinkOptions['batchSize'];
  flushIntervalMs?: OtlpSinkOptions['flushIntervalMs'];
}

export function braintrust(opts: BraintrustSinkOptions): Sink {
  const base = (opts.endpoint ?? 'https://api.braintrust.dev').replace(/\/$/, '');

  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
  };

  // Braintrust's parent-routing header. Either project_logs:<id> or
  // experiment:<id>. Strings (not IDs) are accepted via the named form.
  if (opts.experiment && opts.project) {
    throw new Error('[braintrust sink] pass either project or experiment, not both');
  }
  if (opts.experiment)   headers['x-bt-parent'] = `experiment:${opts.experiment}`;
  else if (opts.project) headers['x-bt-parent'] = `project_logs:${opts.project}`;

  return otlp({
    url: `${base}/otel/v1/traces`,
    headers,
    name: opts.name ?? 'braintrust',
    batchSize: opts.batchSize ?? 50,
    flushIntervalMs: opts.flushIntervalMs ?? 2000,
  });
}
