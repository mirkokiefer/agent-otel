/**
 * In-memory sink — buffers spans in a JS array.
 *
 * Useful for: tests, replay scenarios, in-process span queries (admin
 * debug surfaces, agent self-introspection on a hot ring buffer).
 *
 * Implements `Inspectable`: agents can `findSpans(filter)`, `getTrace(id)`,
 * `stats()` etc. directly against this sink. See `Inspectable` in `types.ts`.
 */

import { matches, and as andMatch } from '../filters.js';
import type {
  Inspectable,
  MatchSpec,
  QueryOptions,
  RoutedSpan,
  Sink,
  TraceStats,
} from '../types.js';

export interface MemorySinkOptions {
  /** Maximum number of spans to retain. Older spans are dropped FIFO. Default: unlimited. */
  capacity?: number;
}

export interface MemorySink extends Sink, Inspectable {
  /** All spans the sink has consumed (subject to capacity). */
  spans: RoutedSpan[];
  /** Drop everything. */
  clear(): void;

  // Narrow Inspectable signatures: memory is in-process, always sync.
  findSpans(filter: MatchSpec, opts?: QueryOptions): RoutedSpan[];
  getSpan(spanId: string, opts?: { where?: MatchSpec }): RoutedSpan | undefined;
  getTrace(traceId: string, opts?: { where?: MatchSpec }): RoutedSpan[];
  stats(filter?: MatchSpec, opts?: { where?: MatchSpec }): TraceStats;
}

export function memory(opts: MemorySinkOptions = {}): MemorySink {
  const buf: RoutedSpan[] = [];
  const cap = opts.capacity ?? Infinity;

  // Indexes for fast lookups. Rebuilt incrementally on consume; cleared on `clear`.
  // FIFO eviction also evicts from the indexes — we walk the dropped span and
  // remove it.
  const bySpanId = new Map<string, RoutedSpan>();
  const byTraceId = new Map<string, RoutedSpan[]>();

  function indexAdd(span: RoutedSpan): void {
    bySpanId.set(span.spanId, span);
    let arr = byTraceId.get(span.traceId);
    if (!arr) { arr = []; byTraceId.set(span.traceId, arr); }
    arr.push(span);
  }

  function indexRemove(span: RoutedSpan): void {
    bySpanId.delete(span.spanId);
    const arr = byTraceId.get(span.traceId);
    if (!arr) return;
    const i = arr.indexOf(span);
    if (i >= 0) arr.splice(i, 1);
    if (arr.length === 0) byTraceId.delete(span.traceId);
  }

  function compose(filter: MatchSpec, where?: MatchSpec): MatchSpec {
    return where ? andMatch(filter, where) : filter;
  }

  function applyOpts(rows: RoutedSpan[], opts?: QueryOptions): RoutedSpan[] {
    const order = opts?.order ?? 'recent';
    const sorted = [...rows].sort((a, b) =>
      order === 'recent'
        ? b.startTimeUnixNano - a.startTimeUnixNano
        : a.startTimeUnixNano - b.startTimeUnixNano,
    );
    const offset = opts?.offset ?? 0;
    const limit  = opts?.limit  ?? 100;
    return sorted.slice(offset, offset + limit);
  }

  return {
    name: 'memory',
    spans: buf,
    clear() {
      buf.length = 0;
      bySpanId.clear();
      byTraceId.clear();
    },
    consume(span) {
      buf.push(span);
      indexAdd(span);
      while (buf.length > cap) {
        const dropped = buf.shift();
        if (dropped) indexRemove(dropped);
      }
    },

    // ---- Inspectable ----

    findSpans(filter, opts) {
      const composed = compose(filter, opts?.where);
      const hits = buf.filter(s => matches(s, composed));
      return applyOpts(hits, opts);
    },

    getSpan(spanId, opts) {
      const s = bySpanId.get(spanId);
      if (!s) return undefined;
      if (opts?.where && !matches(s, opts.where)) return undefined;
      return s;
    },

    getTrace(traceId, opts) {
      const arr = byTraceId.get(traceId) ?? [];
      const filtered = opts?.where ? arr.filter(s => matches(s, opts.where!)) : arr;
      // Trace results are returned in start-time order (oldest first) so the
      // root span comes first. Limit/offset don't apply to single-trace fetch.
      return [...filtered].sort((a, b) => a.startTimeUnixNano - b.startTimeUnixNano);
    },

    stats(filter, opts) {
      const composed: MatchSpec | undefined = filter
        ? compose(filter, opts?.where)
        : (opts?.where ?? undefined);
      const rows = composed ? buf.filter(s => matches(s, composed)) : buf;

      if (rows.length === 0) {
        return {
          spanCount: 0, traceCount: 0, errorCount: 0,
          avgDurationMs: null, totalCost: null,
          earliestStart: null, latestStart: null,
        };
      }

      const traces = new Set<string>();
      let errors = 0;
      let durSum = 0;
      let costSum = 0;
      let costSeen = false;
      let minStart = Infinity;
      let maxStart = -Infinity;

      for (const s of rows) {
        traces.add(s.traceId);
        if (s.status.code === 'ERROR') errors++;
        durSum += s.durationMs;
        const cost = s.attributes['llm.cost.total'];
        if (typeof cost === 'number') { costSum += cost; costSeen = true; }
        if (s.startTimeUnixNano < minStart) minStart = s.startTimeUnixNano;
        if (s.startTimeUnixNano > maxStart) maxStart = s.startTimeUnixNano;
      }

      return {
        spanCount: rows.length,
        traceCount: traces.size,
        errorCount: errors,
        avgDurationMs: durSum / rows.length,
        totalCost: costSeen ? costSum : null,
        earliestStart: new Date(minStart / 1e6).toISOString(),
        latestStart:   new Date(maxStart / 1e6).toISOString(),
      } satisfies TraceStats;
    },
  };
}
