/**
 * In-memory sink — buffers spans in a JS array.
 *
 * Useful for: tests, replay scenarios, "give me the last N spans" debug
 * surfaces. NOT useful for production (no bound, no eviction).
 */

import type { RoutedSpan, Sink } from '../types.js';

export interface MemorySinkOptions {
  /** Maximum number of spans to retain. Older spans are dropped FIFO. Default: unlimited. */
  capacity?: number;
}

export interface MemorySink extends Sink {
  /** All spans the sink has consumed (subject to capacity). */
  spans: RoutedSpan[];
  /** Drop everything. */
  clear(): void;
}

export function memory(opts: MemorySinkOptions = {}): MemorySink {
  const buf: RoutedSpan[] = [];
  const cap = opts.capacity ?? Infinity;

  return {
    name: 'memory',
    spans: buf,
    clear() { buf.length = 0; },
    consume(span) {
      buf.push(span);
      while (buf.length > cap) buf.shift();
    },
  };
}
