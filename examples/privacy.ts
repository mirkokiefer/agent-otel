/**
 * Privacy example: archive sees raw values; vendor sinks see plausible fakes.
 *
 * The bijective map inside the proxy is shared across all wrapped sinks,
 * so the same real PII becomes the same fake everywhere — keeping
 * cross-vendor correlations intact while the real values never leave
 * your canonical archive.
 *
 * Run:
 *   bun run examples/privacy.ts
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';

import { defineRouter } from '../src/index.js';
import { jsonl, memory } from '../src/sinks/index.js';
import { withPrivacy, PrivacyProxy } from '../src/privacy.js';

// One proxy shared across all vendor sinks → consistent fake values
const proxy = new PrivacyProxy({ seed: 42 });

const archive = memory();         // raw — your canonical archive
const phoenixLike = memory();     // pretend this is Phoenix
const braintrustLike = memory();  // pretend this is Braintrust

const router = defineRouter({
  sinks: {
    archive,                                              // raw values
    phoenix:    withPrivacy(phoenixLike,    { proxy }),   // masked
    braintrust: withPrivacy(braintrustLike, { proxy }),   // masked
  },
  rules: [{ match: '*', to: ['archive', 'phoenix', 'braintrust'] }],
});

const sdk = new NodeSDK({ spanProcessors: [router.asSpanProcessor()] });
sdk.start();

const tracer = trace.getTracer('agent-otel-privacy-demo');

// Simulate an LLM call whose input contains an email + a tracking number
const llmSpan = tracer.startSpan('chat anthropic', { kind: SpanKind.CLIENT });
llmSpan.setAttribute('gen_ai.system', 'anthropic');
llmSpan.setAttribute('input.value', JSON.stringify({
  task: 'Email the customer about their shipment',
  to: 'mirko@kiefer.com',
  tracking: 'AETH0000345323DY',
  ip_address: '192.168.1.42',
}));
llmSpan.setAttribute('llm.token_count.prompt', 1234);
llmSpan.setStatus({ code: SpanStatusCode.OK });
llmSpan.end();

await router.flush();
await sdk.shutdown();

console.log('=== ARCHIVE (raw — you own this) ===');
console.log(archive.spans[0]?.attributes['input.value']);
console.log();
console.log('=== PHOENIX (masked — vendor never sees real PII) ===');
console.log(phoenixLike.spans[0]?.attributes['input.value']);
console.log();
console.log('=== BRAINTRUST (also masked, with the SAME fakes) ===');
console.log(braintrustLike.spans[0]?.attributes['input.value']);
console.log();
console.log('Cross-vendor consistency check:');
console.log('  Phoenix and Braintrust see the SAME fake email?',
  phoenixLike.spans[0]?.attributes['input.value'] === braintrustLike.spans[0]?.attributes['input.value']);
