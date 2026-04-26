/**
 * `@daslab/agent-otel` — OTel router for agent telemetry.
 *
 *   import { defineRouter } from '@daslab/agent-otel';
 *   import { jsonl, memory, otlp } from '@daslab/agent-otel/sinks';
 *
 *   const router = defineRouter({
 *     sinks: { archive: jsonl({ path: './traces.jsonl' }), apm: otlp({ url: '...' }) },
 *     rules: [
 *       { match: '*',                          to: ['archive'] },
 *       { match: { 'gen_ai.system': '*' },     to: ['apm']     },
 *     ],
 *   });
 *
 *   const sdk = new NodeSDK({ spanProcessors: [router.asSpanProcessor()] });
 */

export { defineRouter, Router } from './router.js';
export { matches } from './filters.js';

export type {
  RoutedSpan,
  RouterConfig,
  RoutingRule,
  MatchSpec,
  Sink,
  SpanKind,
  StatusCode,
  AttrValue,
  Attributes,
  SpanEvent,
  SpanLink,
} from './types.js';
