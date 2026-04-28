/**
 * E2E: privacy + braintrust composition against the live API.
 *
 * The killer cross-sell pitch: keep using Braintrust, wrap the sink with
 * `withPrivacy()`, and Braintrust never sees real PII.
 *
 * This test proves it for real:
 *   1. Compose router with TWO sinks:
 *      - jsonl archive (RAW values stay local)
 *      - braintrust wrapped with withPrivacy (MASKED before send)
 *   2. Emit a span containing real-looking PII (email + tracking number)
 *   3. Read back from BOTH:
 *      - jsonl file → assert real values present
 *      - Braintrust /v1/project_logs/{id}/fetch → assert real values
 *        ABSENT and plausible-fake values present
 *
 * If this passes, the vendors-see-fakes-you-keep-real claim is grounded
 * in actual API roundtrip, not just unit tests on the masking primitive.
 */

import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { defineRouter } from '../../src/router.js';
import { braintrust } from '../../src/sinks/braintrust.js';
import { jsonl } from '../../src/sinks/jsonl.js';
import { withPrivacy, PrivacyProxy } from '../../src/privacy.js';
import { skipIfMissing, makeTestSpan, randomHex } from './_helpers.js';

const apiKey   = skipIfMissing('BRAINTRUST_API_KEY');
const endpoint = process.env.BRAINTRUST_ENDPOINT ?? 'https://api.braintrust.dev';
const project  = process.env.BRAINTRUST_PROJECT  ?? 'agent-otel-e2e';

async function resolveProjectId(): Promise<string | null> {
  const res = await fetch(`${endpoint}/v1/project?project_name=${encodeURIComponent(project)}&limit=1`, {
    headers: { Authorization: `Bearer ${apiKey!}` },
  });
  if (!res.ok) return null;
  const body = await res.json() as { objects?: Array<{ id: string; name: string }> };
  return body.objects?.[0]?.id ?? null;
}

async function fetchRecentEvents(projectId: string, limit = 100): Promise<Array<Record<string, unknown>>> {
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

test('privacy + braintrust: archive sees raw, Braintrust sees fakes (live API)', async () => {
  if (!apiKey) return;

  // Three categories the test exercises:
  //   1) Auto-detected PII (email)  — pii-proxy masks it without config
  //   2) Hard-redacted key (auth)   — `redactKeys` replaces with '[redacted]'
  //   3) Passthrough key (marker)   — preserved verbatim so we can FIND
  //                                    our event among recent ones
  const realEmail = `mirko-test-${randomHex(6)}@kiefer.com`;
  const realToken = `sk-secret-${randomHex(12)}`;
  const marker    = randomHex(12);

  const tmpDir = mkdtempSync(join(tmpdir(), 'agent-otel-privacy-'));
  const archivePath = join(tmpDir, 'archive.jsonl');

  try {
    const proxy = new PrivacyProxy();
    const router = defineRouter({
      sinks: {
        archive:    jsonl({ path: archivePath }),
        braintrust: withPrivacy(
          braintrust({ apiKey: apiKey!, project, endpoint }),
          {
            proxy,
            redactKeys: ['auth.token'],
            // Marker is high-entropy hex; we want it preserved on the
            // vendor side so we can find OUR event in /fetch
            passthroughKeys: ['agent_otel.marker'],
          },
        ),
      },
      rules: [{ match: '*', to: ['archive', 'braintrust'] }],
    });

    const span = makeTestSpan({
      name: `agent-otel-privacy-e2e-${marker}`,
      attributes: {
        'agent_otel.marker': marker,
        'user.email':        realEmail,
        'auth.token':        realToken,
        // Embedded JSON — pii-proxy walks string values inside JSON shapes
        'input.value':       JSON.stringify({ to: realEmail }),
      },
    });

    await router.route(span);
    await router.flush();
    await router.shutdown();

    // ---- ARCHIVE: real values present ----
    const archived = readFileSync(archivePath, 'utf8');
    expect(archived).toContain(realEmail);
    expect(archived).toContain(realToken);
    expect(archived).toContain(marker);

    // ---- BRAINTRUST: poll fetch until our marker shows up ----
    const projectId = await resolveProjectId();
    expect(projectId).toBeTruthy();
    if (!projectId) return;

    const found = await pollFor(
      projectId,
      ev => JSON.stringify(ev).includes(marker),
      { timeoutMs: 30_000, intervalMs: 1500 },
    );
    expect(found).not.toBeNull();
    if (!found) return;

    const flat = JSON.stringify(found);

    // The whole point: Braintrust sees plausible-fake email, NOT the real one
    expect(flat).not.toContain(realEmail);
    // Hard-redacted: the secret is replaced literally with '[redacted]', not
    // a fake. Real value MUST be absent.
    expect(flat).not.toContain(realToken);
    expect(flat).toContain('[redacted]');

    // Passthrough: the marker is preserved verbatim (otherwise we couldn't
    // have found this event in the first place — sanity check)
    expect(flat).toContain(marker);

    // Sanity: pii-proxy substituted SOMETHING email-shaped for the email.
    // We don't assert the exact fake (random per run) — just that an
    // @-bearing string survived the masking pass.
    expect(flat).toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}, 60_000);
