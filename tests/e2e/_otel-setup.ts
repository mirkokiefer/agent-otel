/**
 * Shared OTel setup for e2e instrument tests.
 *
 * Each `instrument-*.test.ts` file used to spin up its own NodeSDK in a
 * `beforeAll` hook. That breaks when running multiple test files in
 * one `bun test` invocation: OTel allows exactly one global tracer
 * provider per process — the second `NodeSDK.start()` call is a no-op,
 * so spans from the second test file go nowhere.
 *
 * Fix: initialize the SDK ONCE here (idempotent guard) and expose a
 * shared `memSink` that every instrument test reads from. Each test
 * captures `memSink.spans.length` before its API call and slices off
 * only the new entries afterward — works whether the file runs alone
 * or in a sequence.
 *
 * Usage:
 *
 *   import { sharedMemSink, ensureOtel } from './_otel-setup.js';
 *
 *   beforeAll(() => ensureOtel());
 *
 *   test('...', async () => {
 *     const before = sharedMemSink.spans.length;
 *     // ... call instrumented client ...
 *     const newSpans = sharedMemSink.spans.slice(before);
 *     // assertions on newSpans
 *   });
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';

import { defineRouter } from '../../src/router.js';
import { memory } from '../../src/sinks/memory.js';

/**
 * Single memory sink shared across all instrument tests. Tests track
 * `before/after` counts to isolate their own spans without polluting
 * each other.
 */
export const sharedMemSink = memory();

const sharedRouter = defineRouter({
  sinks: { mem: sharedMemSink },
  rules: [{ match: '*', to: ['mem'] }],
});

let sdk: NodeSDK | null = null;
let started = false;

function toRouted(span: any): any {
  const startNs = span.startTime[0] * 1e9 + span.startTime[1];
  const endNs   = span.endTime[0]   * 1e9 + span.endTime[1];
  const KIND_NAMES   = ['INTERNAL','SERVER','CLIENT','PRODUCER','CONSUMER'];
  const STATUS_NAMES = ['UNSET','OK','ERROR'];
  return {
    traceId: span.spanContext().traceId,
    spanId:  span.spanContext().spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    name: span.name,
    kind: KIND_NAMES[span.kind] ?? 'INTERNAL',
    status: { code: STATUS_NAMES[span.status.code] ?? 'UNSET', message: span.status.message },
    startTimeUnixNano: startNs,
    endTimeUnixNano:   endNs,
    durationMs:       (endNs - startNs) / 1e6,
    attributes: { ...(span.attributes ?? {}) },
    events: [],
    links:  [],
    resource: { ...(span.resource?.attributes ?? {}) },
    scope: { name: span.instrumentationScope.name, version: span.instrumentationScope.version },
  };
}

/** Idempotent SDK init. Safe to call from any beforeAll hook. */
export function ensureOtel(): void {
  if (started) return;
  started = true;

  sdk = new NodeSDK({
    resource: resourceFromAttributes({ 'service.name': 'agent-otel-instrument-e2e' }),
    spanProcessors: [
      {
        onStart() {},
        onEnd(span)   { void sharedRouter.route(toRouted(span)); },
        async forceFlush() { await sharedRouter.flush();  },
        async shutdown()   { await sharedRouter.shutdown(); },
      } as any,
    ],
  });
  sdk.start();
}

/** Best-effort teardown for tests that want a clean process exit. */
export async function shutdownOtel(): Promise<void> {
  if (!started) return;
  await sdk?.shutdown();
  sdk = null;
  started = false;
}
