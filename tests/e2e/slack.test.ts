/**
 * E2E: slack sink → real Slack incoming webhook.
 *
 * Required env:
 *   SLACK_WEBHOOK_URL     incoming webhook URL
 *
 * What we verify:
 *   - The slack sink posts a message and Slack returns HTTP 200.
 *   - Default formatter produces a valid payload (no Slack 400s).
 *
 * What we don't verify:
 *   - That the message appeared in the channel — Slack doesn't expose
 *     readback for incoming webhooks.
 */

import { test, expect } from 'bun:test';
import { slack } from '../../src/sinks/slack.js';
import { skipIfMissing, makeTestSpan, randomHex } from './_helpers.js';

const webhookUrl = skipIfMissing('SLACK_WEBHOOK_URL');

test('slack sink — webhook accepts the message', async () => {
  if (!webhookUrl) return;

  const marker = randomHex(8);
  const span = makeTestSpan({
    name: `agent-otel-e2e-${marker}`,
    status: { code: 'ERROR', message: `e2e test ${marker} (this is intentional)` },
    attributes: {
      'agent_otel.marker': marker,
      'llm.cost.total': 1.42,
      'gen_ai.system': 'anthropic',
    },
  });

  const sink = slack({ webhookUrl: webhookUrl! });
  await sink.consume(span);

  // No throw == HTTP 200 from Slack. Slack's webhook endpoint returns the
  // string "ok" on success, non-2xx + error message otherwise; the sink
  // throws on non-OK.
  expect(true).toBe(true);
}, 15_000);
