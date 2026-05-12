/**
 * Braintrust sink.
 *
 * Braintrust (https://braintrust.dev) accepts OTel spans at their OTLP
 * endpoint and maps them into Logs / Experiments based on the `x-bt-parent`
 * header. This sink wraps the generic OTLP sink with Braintrust-specific
 * defaults and the right header format.
 *
 * Endpoint reference (as of 2026-04):
 *   https://api.braintrust.dev/otel/v1/traces
 *
 * `x-bt-parent` header — valid prefixes (per
 *   https://www.braintrust.dev/docs/integrations/opentelemetry):
 *     project_name:<name>     ← string, project auto-created if missing
 *     project_id:<uuid>       ← UUID
 *     experiment_id:<uuid>    ← UUID (look up via /v1/experiment)
 *     <span-slug>             ← from span.export() for distributed tracing
 *
 * Common bug we hit and fixed: passing `project_logs:<name>` as the header
 * value. That's the SQL/BTQL table identifier — NOT a header prefix.
 * Braintrust falls through to span-slug parsing and rejects with
 * "Missing update access to span id". Use `project_name:<name>` instead.
 *
 * Usage:
 *   import { braintrust } from 'agent-otel/sinks/braintrust';
 *
 *   const sink = braintrust({
 *     apiKey:  process.env.BRAINTRUST_API_KEY!,
 *     project: 'support-agent',          // by name (recommended)
 *     // OR: projectId: '<uuid>',
 *     // OR: experimentId: '<uuid>',
 *   });
 */

import type { Sink } from '../types.js';
import { otlp, type OtlpSinkOptions } from './otlp.js';

export interface BraintrustSinkOptions {
  /** Braintrust API key. Required. */
  apiKey: string;
  /**
   * Project name. Spans land in this project's logs. Project is
   * auto-created if missing on first write.
   *
   * Use this OR `projectId` OR `experimentId` — not multiple.
   */
  project?: string;
  /**
   * Project UUID. Use this when you've already resolved the id and want to
   * skip name lookup on Braintrust's side.
   */
  projectId?: string;
  /**
   * Experiment UUID. Spans land in this experiment instead of logs.
   * Look up the UUID via `GET /v1/experiment?experiment_name=...`.
   */
  experimentId?: string;
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

  const targets = [opts.project, opts.projectId, opts.experimentId].filter(Boolean);
  if (targets.length > 1) {
    throw new Error('[braintrust sink] pass exactly one of project | projectId | experimentId');
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
  };
  if (opts.experimentId)    headers['x-bt-parent'] = `experiment_id:${opts.experimentId}`;
  else if (opts.projectId)  headers['x-bt-parent'] = `project_id:${opts.projectId}`;
  else if (opts.project)    headers['x-bt-parent'] = `project_name:${opts.project}`;

  return otlp({
    url: `${base}/otel/v1/traces`,
    headers,
    name: opts.name ?? 'braintrust',
    batchSize: opts.batchSize ?? 50,
    flushIntervalMs: opts.flushIntervalMs ?? 2000,
  });
}
