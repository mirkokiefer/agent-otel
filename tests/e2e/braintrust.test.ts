/**
 * E2E: braintrust sink — POST a span via OTLP, then READ IT BACK via the
 * REST fetch API to verify it actually landed in Braintrust's storage.
 *
 * The previous version of this test treated a 403 "Missing update access"
 * error as an acceptable outcome ("known Braintrust-side constraint"). That
 * masked a real bug: we were sending `x-bt-parent: project_logs:<name>` —
 * an invalid header value — which Braintrust silently rejected. Fixed in
 * the sink by switching to `project_name:<name>`.
 *
 * This test now verifies the full collect+query loop:
 *   1. POST a span via the sink → expect 200
 *   2. GET /v1/project_logs/{project_id}/fetch and find our span by its
 *      unique marker attribute → expect non-empty
 *
 * Required env:
 *   BRAINTRUST_API_KEY        Braintrust API key
 *
 * Optional env:
 *   BRAINTRUST_PROJECT        target project (default: 'agent-otel-e2e' —
 *                             auto-created on first write)
 *   BRAINTRUST_ENDPOINT       override base URL
 */

import { test, expect } from 'bun:test';
import { braintrust } from '../../src/sinks/braintrust.js';
import { skipIfMissing, makeTestSpan, randomHex } from './_helpers.js';

const apiKey  = skipIfMissing('BRAINTRUST_API_KEY');
const endpoint = process.env.BRAINTRUST_ENDPOINT ?? 'https://api.braintrust.dev';
const project  = process.env.BRAINTRUST_PROJECT  ?? 'agent-otel-e2e';

/** Look up the project's UUID by name. */
async function resolveProjectId(): Promise<string | null> {
  const res = await fetch(`${endpoint}/v1/project?project_name=${encodeURIComponent(project)}&limit=1`, {
    headers: { Authorization: `Bearer ${apiKey!}` },
  });
  if (!res.ok) return null;
  const body = await res.json() as { objects?: Array<{ id: string; name: string }> };
  return body.objects?.[0]?.id ?? null;
}

/** Fetch recent project log events. Returns an array of event objects. */
async function fetchRecentEvents(projectId: string, limit = 50): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${endpoint}/v1/project_logs/${projectId}/fetch?limit=${limit}`, {
    headers: { Authorization: `Bearer ${apiKey!}` },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`fetch project_logs failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  const body = await res.json() as { events?: Array<Record<string, unknown>> };
  return body.events ?? [];
}

/**
 * Poll fetch until we find an event matching `predicate`, or timeout.
 * Braintrust ingest is fast but not instantaneous — small read-after-write
 * delay is normal.
 */
async function pollFor(
  projectId: string,
  predicate: (ev: Record<string, unknown>) => boolean,
  opts: { timeoutMs: number; intervalMs?: number } = { timeoutMs: 30_000 },
): Promise<Record<string, unknown> | null> {
  const interval = opts.intervalMs ?? 1500;
  const t0 = Date.now();
  while (Date.now() - t0 < opts.timeoutMs) {
    const events = await fetchRecentEvents(projectId, 100);
    const hit = events.find(predicate);
    if (hit) return hit;
    await new Promise(r => setTimeout(r, interval));
  }
  return null;
}

test('braintrust sink — POST → 200, then fetch back to verify ingest', async () => {
  if (!apiKey) return;

  // Mint a unique marker so we can find OUR span among recent events.
  const marker = randomHex(12);
  const span = makeTestSpan({
    name: `agent-otel-e2e-${marker}`,
    attributes: {
      'agent_otel.marker': marker,
      'agent_otel.test_run': 'braintrust-e2e',
    },
  });

  // 1. Write
  const sink = braintrust({ apiKey, project, endpoint });
  await sink.consume(span);
  await sink.flush?.();
  await sink.shutdown?.();

  // 2. Resolve project id (the project may have just been auto-created)
  const projectId = await resolveProjectId();
  expect(projectId).toBeTruthy();

  // 3. Read back — poll because ingest isn't instantaneous
  const found = await pollFor(
    projectId!,
    ev => {
      // Marker shows up somewhere in the event payload depending on how
      // Braintrust maps OTLP attributes to its event shape — flat-search.
      const flat = JSON.stringify(ev);
      return flat.includes(marker);
    },
    { timeoutMs: 30_000, intervalMs: 1500 },
  );

  expect(found).not.toBeNull();
  if (!found) return;

  // Sanity: the event has a span_id and root_span_id (Braintrust's shape).
  expect(found.span_id).toBeDefined();
  expect(found.root_span_id).toBeDefined();
}, 60_000);
