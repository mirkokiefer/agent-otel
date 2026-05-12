/**
 * Helpers shared across e2e tests.
 */

import type { RoutedSpan } from '../../src/types.js';

const skippedKeys = new Set<string>();

/**
 * Read an env var, or return undefined and log a one-line skip message
 * (only once per env var name across the whole test run, to avoid spam).
 */
export function skipIfMissing(name: string): string | undefined {
  const v = process.env[name];
  if (v) return v;
  if (!skippedKeys.has(name)) {
    console.log(`[e2e] skipping tests requiring ${name} (env not set)`);
    skippedKeys.add(name);
  }
  return undefined;
}

/**
 * Build a minimal RoutedSpan for testing. Override fields via `partial`.
 * The default span carries non-trivial attributes so vendors have something
 * to display when humans browse the result.
 */
export function makeTestSpan(partial: Partial<RoutedSpan> = {}): RoutedSpan {
  const now = Date.now() * 1e6;
  return {
    traceId:       partial.traceId ?? randomHex(32),
    spanId:        partial.spanId ?? randomHex(16),
    parentSpanId:  partial.parentSpanId,
    name:          partial.name ?? 'agent-otel-e2e',
    kind:          partial.kind ?? 'CLIENT',
    status:        partial.status ?? { code: 'OK' },
    startTimeUnixNano: partial.startTimeUnixNano ?? now,
    endTimeUnixNano:   partial.endTimeUnixNano   ?? now + 100_000_000,
    durationMs:        partial.durationMs        ?? 100,
    attributes: {
      'gen_ai.system': 'anthropic',
      'gen_ai.request.model': 'claude-sonnet-4-6',
      'llm.token_count.prompt': 1234,
      'llm.token_count.completion': 567,
      'llm.cost.total': 0.034,
      'agent_otel.test': true,
      'agent_otel.test_run_id': randomHex(8),
      ...(partial.attributes ?? {}),
    },
    events: partial.events ?? [],
    links:  partial.links  ?? [],
    resource: partial.resource ?? { 'service.name': 'agent-otel-e2e' },
    scope:    partial.scope    ?? { name: 'agent-otel-e2e', version: '0.0.4' },
  };
}

export function randomHex(len: number): string {
  const bytes = new Uint8Array(Math.ceil(len / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, len);
}
