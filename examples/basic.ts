/**
 * Basic example: emit a few OTel spans, fan them out to:
 *   - a JSONL file (everything)
 *   - an in-memory buffer (LLM spans only)
 *
 * Run:
 *   bun run examples/basic.ts
 *   cat /tmp/agent-otel-demo.jsonl
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';

import { defineRouter } from '../src/index.js';
import { jsonl, memory } from '../src/sinks/index.js';

const allSpans  = memory();
const llmSpans  = memory();

const router = defineRouter({
  sinks: {
    archive: jsonl({ path: '/tmp/agent-otel-demo.jsonl' }),
    all:     allSpans,
    llm:     llmSpans,
  },
  rules: [
    { match: '*',                          to: ['archive', 'all'], name: 'archive-everything' },
    { match: { 'gen_ai.system': '*' },     to: ['llm'],            name: 'llm-only'           },
    { match: { 'status_code': 'ERROR' },   to: ['archive'],        name: 'errors-loud'        },
  ],
});

const sdk = new NodeSDK({
  spanProcessors: [router.asSpanProcessor()],
});
sdk.start();

const tracer = trace.getTracer('agent-otel-demo');

// 1. A non-LLM tool span
const dbSpan = tracer.startSpan('postgres_query', { kind: SpanKind.CLIENT });
dbSpan.setAttribute('db.system', 'postgresql');
dbSpan.setAttribute('db.statement', 'SELECT 1');
dbSpan.setAttribute('db.rows_affected', 1);
dbSpan.setStatus({ code: SpanStatusCode.OK });
dbSpan.end();

// 2. An LLM span
const llmSpan = tracer.startSpan('chat anthropic', { kind: SpanKind.CLIENT });
llmSpan.setAttribute('gen_ai.system', 'anthropic');
llmSpan.setAttribute('gen_ai.request.model', 'claude-sonnet-4-6');
llmSpan.setAttribute('llm.token_count.prompt', 1234);
llmSpan.setAttribute('llm.token_count.completion', 567);
llmSpan.setAttribute('llm.cost.total', 0.034);
llmSpan.setStatus({ code: SpanStatusCode.OK });
llmSpan.end();

// 3. An error span
const errSpan = tracer.startSpan('http_request', { kind: SpanKind.CLIENT });
errSpan.setAttribute('http.request.method', 'GET');
errSpan.setAttribute('url.full', 'https://example.com/oops');
errSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'connection refused' });
errSpan.end();

await router.flush();
await sdk.shutdown();

console.log('---');
console.log('all sink received      :', allSpans.spans.length, 'spans');
console.log('llm sink received      :', llmSpans.spans.length, 'spans');
console.log('archive (jsonl) wrote  : /tmp/agent-otel-demo.jsonl');
console.log();
console.log('LLM-routed span:');
console.log(' ', llmSpans.spans[0]?.name, llmSpans.spans[0]?.attributes['gen_ai.system'], llmSpans.spans[0]?.attributes['llm.cost.total']);
