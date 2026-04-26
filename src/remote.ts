/**
 * Remote-mode Inspectable.
 *
 * Used by `scry` CLI when run outside the server process — most importantly
 * inside sandbox environments. The CLI connects to a hosted scry endpoint with
 * a signed scoped token in its env. The server validates the token, applies
 * scope as a non-bypassable `where` filter, and answers queries.
 *
 * Auth is handled entirely server-side via the bearer token. The CLI never
 * sees scope claims; it just makes HTTP calls.
 */

import type {
  Inspectable,
  MatchSpec,
  QueryOptions,
  RoutedSpan,
  TraceStats,
} from './types.js';

export interface RemoteInspectableOptions {
  endpoint: string;     // e.g. 'https://api.example.com/v1/scry'
  token: string;        // JWT bearer
  fetch?: typeof globalThis.fetch;   // override for tests
}

export class RemoteInspectable implements Inspectable {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(opts: RemoteInspectableOptions) {
    // Normalize: strip trailing slash so we can append `/op` cleanly.
    this.endpoint = opts.endpoint.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async post(op: string, body: unknown): Promise<unknown> {
    const res = await this.fetchFn(`${this.endpoint}/${op}`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const j = await res.json() as { error?: string };
        if (j.error) detail = `${res.status}: ${j.error}`;
      } catch { /* response wasn't JSON */ }
      throw new Error(`scry remote ${op} failed — ${detail}`);
    }
    return res.json();
  }

  async findSpans(filter: MatchSpec, opts?: QueryOptions): Promise<RoutedSpan[]> {
    // Server enforces scope via the token; opts.where is informational only here.
    const body = {
      filter,
      limit: opts?.limit ?? 100,
    };
    const j = await this.post('query', body) as { spans: RoutedSpan[] };
    return j.spans;
  }

  async getSpan(_spanId: string): Promise<RoutedSpan | undefined> {
    // Not exposed in the v1 HTTP surface — the CLI doesn't need it. Could
    // be added if a use case appears (e.g., agent dereferencing a span_id
    // from another tool's output).
    throw new Error('getSpan is not supported in remote mode (yet)');
  }

  async getTrace(traceId: string): Promise<RoutedSpan[]> {
    const j = await this.post('trace', { trace_id: traceId }) as { spans: RoutedSpan[] };
    return j.spans;
  }

  async stats(filter?: MatchSpec): Promise<TraceStats> {
    const j = await this.post('stats', { filter }) as { stats: TraceStats };
    return j.stats;
  }
}
