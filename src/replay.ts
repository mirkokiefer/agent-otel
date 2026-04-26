/**
 * Replay — re-route stored spans through a Router as if they were live.
 *
 * Three flavors of "replay" exist conceptually:
 *
 *   1. **Re-route** — take spans you already captured, send them to
 *      additional sinks. "I have 10K production traces in JSONL; I want
 *      to also send them to Braintrust now to evaluate retroactively."
 *      Implemented in v0.0.2 (this module).
 *
 *   2. **Re-execute** — take a trace and run the same input through
 *      the same agent again, producing a new trace. "Did my latest
 *      deploy change behavior?" Requires an executor / runtime kernel.
 *      Planned.
 *
 *   3. **Counterfactual** — same as re-execute, but with one thing
 *      swapped. "What if I'd used Sonnet 4.7 instead of Sonnet 4.6?"
 *      Planned.
 *
 * This module does (1) cleanly. The router doesn't know it's replay vs
 * live — sinks see RoutedSpans as if they came from the OTel SpanProcessor.
 *
 * Usage:
 *   import { replay, fromJsonl } from 'agent-otel/replay';
 *   import { defineRouter } from 'agent-otel';
 *   import { phoenix, braintrust } from 'agent-otel/sinks';
 *
 *   await replay({
 *     source: fromJsonl('./prod-traces.jsonl'),
 *     router: defineRouter({
 *       sinks: { phoenix: phoenix({ apiKey: ... }), braintrust: braintrust({...}) },
 *       rules: [{ match: '*', to: ['phoenix', 'braintrust'] }],
 *     }),
 *   });
 *
 * A/B comparing destinations — pipe the same trace to two backends
 * simultaneously, see which renders the data better. Nobody else can do
 * this because storage and routing are usually owned by the destination.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import type { Router } from './router.js';
import type { RoutedSpan } from './types.js';

/**
 * A source of historical spans. Async iterable so we can stream large
 * files without loading them all into memory.
 */
export type SpanSource = AsyncIterable<RoutedSpan>;

export interface ReplayOptions {
  source: SpanSource;
  router: Router;
  /**
   * Maximum spans to replay. Useful for spot-checks against large archives.
   * Default: no limit.
   */
  limit?: number;
  /**
   * Filter applied to each source span BEFORE routing. Lets you replay a
   * subset (e.g. only spans from one trace, only LLM spans, only spans
   * after a given timestamp).
   */
  where?: (span: RoutedSpan) => boolean;
  /**
   * Optional transform applied to each span before routing — e.g. swap
   * an attribute, mask PII, override the trace_id to mark replays.
   * Returning null/undefined skips the span.
   */
  transform?: (span: RoutedSpan) => RoutedSpan | null | undefined;
  /**
   * Called every N spans for progress reporting. Default: every 1000.
   */
  onProgress?: (n: number) => void;
}

/** Result summary returned after a replay run. */
export interface ReplayResult {
  spansSeen: number;
  spansRouted: number;
  spansSkipped: number;
  durationMs: number;
}

/**
 * Replay spans through a Router. Streams source → optional filter →
 * optional transform → router. Awaits the router's flush at the end so
 * sinks have drained when the function returns.
 */
export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const t0 = Date.now();
  let seen = 0, routed = 0, skipped = 0;

  for await (const raw of opts.source) {
    seen++;
    if (opts.limit && routed >= opts.limit) break;

    if (opts.where && !opts.where(raw)) { skipped++; continue; }
    const span = opts.transform ? opts.transform(raw) : raw;
    if (!span) { skipped++; continue; }

    await opts.router.route(span);
    routed++;
    if (opts.onProgress && routed % 1000 === 0) opts.onProgress(routed);
  }

  await opts.router.flush();

  return { spansSeen: seen, spansRouted: routed, spansSkipped: skipped, durationMs: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// Sources — bring spans in from storage
// ---------------------------------------------------------------------------

/**
 * Stream RoutedSpans from a JSONL file produced by the `jsonl` sink (or
 * any compatible serialization). One JSON object per line.
 */
export function fromJsonl(path: string): SpanSource {
  return {
    async *[Symbol.asyncIterator]() {
      const stream = createReadStream(path, { encoding: 'utf8' });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed) as RoutedSpan;
        } catch (err) {
          console.warn('[agent-otel/replay] skipping malformed JSONL line:', err);
        }
      }
    },
  };
}

/**
 * Stream RoutedSpans from any in-memory iterable. Useful for tests and for
 * piping spans you collected in a memory() sink.
 */
export function fromArray(spans: Iterable<RoutedSpan>): SpanSource {
  return {
    async *[Symbol.asyncIterator]() {
      for (const span of spans) yield span;
    },
  };
}
