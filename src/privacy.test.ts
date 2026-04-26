/**
 * Tests for agent-otel/privacy.
 *
 * Focuses on three things:
 *   1. The wrapper is transparent (consume passes through, flush/shutdown propagate).
 *   2. Spans visible to the wrapped sink have PII masked.
 *   3. The bijective map is shared when a single proxy is reused, so the
 *      same real PII gets the same fake across multiple wrapped sinks.
 */

import { test, expect } from 'bun:test';
import { PrivacyProxy } from 'pii-proxy';
import { defineRouter } from './router.js';
import { memory } from './sinks/memory.js';
import { withPrivacy, maskSpan } from './privacy.js';
import type { RoutedSpan } from './types.js';

const mk = (overrides: Partial<RoutedSpan> = {}): RoutedSpan => ({
  traceId: 't', spanId: 's', name: 'demo',
  kind: 'CLIENT', status: { code: 'OK' },
  startTimeUnixNano: 0, endTimeUnixNano: 1, durationMs: 0,
  attributes: {}, events: [], links: [],
  resource: {}, scope: { name: 'test' },
  ...overrides,
});

test('withPrivacy masks email in attributes', async () => {
  const sink = memory();
  const wrapped = withPrivacy(sink, { proxy: new PrivacyProxy({ seed: 1 }) });

  await wrapped.consume(mk({
    attributes: {
      'input.value': '{"to": "mirko@kiefer.com", "subject": "hi"}',
      'gen_ai.system': 'anthropic',
    },
  }));

  const seen = sink.spans[0]!;
  expect(seen.attributes['gen_ai.system']).toBe('anthropic'); // not PII, untouched
  expect(seen.attributes['input.value']).toBeString();
  expect(seen.attributes['input.value']).not.toContain('mirko@kiefer.com'); // masked
});

test('shared proxy maps same real PII to same fake across wrapped sinks', async () => {
  const proxy = new PrivacyProxy({ seed: 42 });
  const sinkA = memory();
  const sinkB = memory();
  const wrappedA = withPrivacy(sinkA, { proxy });
  const wrappedB = withPrivacy(sinkB, { proxy });

  // The same real email appears in both spans
  const span = mk({ attributes: { email: 'mirko@kiefer.com' } });

  await wrappedA.consume(span);
  await wrappedB.consume(span);

  // Both wrapped sinks see the SAME fake (because the proxy is shared)
  expect(sinkA.spans[0]!.attributes.email).toBe(sinkB.spans[0]!.attributes.email);
  // And it's not the real value
  expect(sinkA.spans[0]!.attributes.email).not.toBe('mirko@kiefer.com');
});

test('redactKeys hard-redacts before masking', async () => {
  const sink = memory();
  const wrapped = withPrivacy(sink, {
    proxy: new PrivacyProxy({ seed: 1 }),
    redactKeys: ['daslab.auth.token'],
  });

  await wrapped.consume(mk({
    attributes: {
      'daslab.auth.token': 'sk-very-secret-1234567890',
      'input.value': 'something innocuous',
    },
  }));

  expect(sink.spans[0]!.attributes['daslab.auth.token']).toBe('[redacted]');
});

test('passthroughKeys skip masking on listed keys', async () => {
  const sink = memory();
  const wrapped = withPrivacy(sink, {
    proxy: new PrivacyProxy({ seed: 1 }),
    passthroughKeys: [/^daslab\./],
  });

  await wrapped.consume(mk({
    attributes: {
      'daslab.span.id': 'span_with_uuid_b8a4c2e6-1234-5678-9abc-def012345678',
      'input.value': 'Email mirko@kiefer.com',
    },
  }));

  // daslab.* untouched (regex matched)
  expect(sink.spans[0]!.attributes['daslab.span.id']).toBe(
    'span_with_uuid_b8a4c2e6-1234-5678-9abc-def012345678',
  );
  // input.value still masked (didn't match regex)
  expect(sink.spans[0]!.attributes['input.value']).not.toContain('mirko@kiefer.com');
});

test('events attributes also masked', async () => {
  const sink = memory();
  const wrapped = withPrivacy(sink, { proxy: new PrivacyProxy({ seed: 1 }) });

  await wrapped.consume(mk({
    events: [{
      name: 'tool.invoked',
      timeUnixNano: 100,
      attributes: { 'user.email': 'mirko@kiefer.com' },
    }],
  }));

  const eventAttrs = sink.spans[0]!.events[0]!.attributes!;
  expect(eventAttrs['user.email']).toBeString();
  expect(eventAttrs['user.email']).not.toBe('mirko@kiefer.com');
});

test('maskNames=true masks span name and status message', async () => {
  const sink = memory();
  const wrapped = withPrivacy(sink, {
    proxy: new PrivacyProxy({ seed: 1 }),
    maskNames: true,
  });

  await wrapped.consume(mk({
    name: 'send email to mirko@kiefer.com',
    status: { code: 'ERROR', message: 'failed: mirko@kiefer.com bounced' },
  }));

  expect(sink.spans[0]!.name).not.toContain('mirko@kiefer.com');
  expect(sink.spans[0]!.status.message).not.toContain('mirko@kiefer.com');
});

test('maskNames=false (default) leaves names and status messages alone', async () => {
  const sink = memory();
  const wrapped = withPrivacy(sink, { proxy: new PrivacyProxy({ seed: 1 }) });

  await wrapped.consume(mk({
    name: 'postgres_query',
    status: { code: 'ERROR', message: 'connection timeout' },
  }));

  expect(sink.spans[0]!.name).toBe('postgres_query');
  expect(sink.spans[0]!.status.message).toBe('connection timeout');
});

test('end-to-end via Router: archive sees raw, vendor sees masked', async () => {
  const proxy = new PrivacyProxy({ seed: 7 });
  const archive = memory();
  const vendor = memory();

  const router = defineRouter({
    sinks: {
      archive,
      vendor: withPrivacy(vendor, { proxy }),
    },
    rules: [{ match: '*', to: ['archive', 'vendor'] }],
  });

  await router.route(mk({
    attributes: {
      'gen_ai.system': 'anthropic',
      'input.value': '{"email":"mirko@kiefer.com","tracking":"AETH0000345323DY"}',
    },
  }));

  // Archive: raw values
  expect(archive.spans[0]!.attributes['input.value']).toContain('mirko@kiefer.com');
  expect(archive.spans[0]!.attributes['input.value']).toContain('AETH0000345323DY');
  // Vendor: fakes
  expect(vendor.spans[0]!.attributes['input.value']).not.toContain('mirko@kiefer.com');
  expect(vendor.spans[0]!.attributes['input.value']).not.toContain('AETH0000345323DY');
});

test('maskSpan is pure (does not mutate input)', () => {
  const proxy = new PrivacyProxy({ seed: 1 });
  const original = mk({ attributes: { email: 'mirko@kiefer.com' } });
  const beforeAttr = original.attributes.email;

  const masked = maskSpan(original, proxy);

  expect(original.attributes.email).toBe(beforeAttr); // unchanged
  expect(masked.attributes.email).not.toBe(beforeAttr); // new object has fake
});
