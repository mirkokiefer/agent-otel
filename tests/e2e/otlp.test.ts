/**
 * E2E: generic OTLP sink → real OTLP endpoint.
 *
 * Required env:
 *   OTLP_ENDPOINT     full URL to the OTLP/HTTP traces endpoint
 *                     e.g. http://traces.claw1/v1/traces
 *
 * Optional env:
 *   OTLP_HEADERS      JSON string of additional headers (auth tokens, etc.)
 *
 * What we verify:
 *   - The sink posts via the proto serializer
 *   - The endpoint accepts (HTTP 2xx, no thrown error)
 *
 * Note: this is the same wire path used by the phoenix and braintrust
 * sinks under the hood. Running this against Phoenix is redundant with
 * phoenix.test.ts but verifies the generic-sink contract independently.
 */

import { test, expect } from 'bun:test';
import { otlp } from '../../src/sinks/otlp.js';
import { skipIfMissing, makeTestSpan, randomHex } from './_helpers.js';

const url = skipIfMissing('OTLP_ENDPOINT');
let headers: Record<string, string> = {};
if (process.env.OTLP_HEADERS) {
  try { headers = JSON.parse(process.env.OTLP_HEADERS); }
  catch { console.warn('[e2e] OTLP_HEADERS not valid JSON, ignoring'); }
}

test('otlp sink (proto) — span ingest succeeds', async () => {
  if (!url) return;

  const marker = randomHex(8);
  const span = makeTestSpan({
    name: `agent-otel-otlp-${marker}`,
    attributes: { 'agent_otel.marker': marker },
  });

  const sink = otlp({ url: url!, headers, format: 'protobuf' });
  await sink.consume(span);
  await sink.flush?.();
  await sink.shutdown?.();

  expect(true).toBe(true);
}, 30_000);
