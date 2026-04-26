/**
 * `agent-otel` — OTel router for agent telemetry.
 *
 *   import { defineRouter } from 'agent-otel';
 *   import { jsonl, memory, otlp, phoenix, braintrust, slack } from 'agent-otel/sinks';
 *   import { replay, fromJsonl } from 'agent-otel/replay';
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
 *
 *   // ...later, replay archived spans through new sinks:
 *   await replay({ source: fromJsonl('./traces.jsonl'), router: anotherRouter });
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
