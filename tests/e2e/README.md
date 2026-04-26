# `agent-otel` end-to-end tests

These tests hit **real services**. They're separated from the unit tests
in `src/*.test.ts` because they require credentials and network access,
and run against external systems.

## Running

```bash
# Run only e2e tests (skips any test whose creds aren't set)
bun test:e2e

# Run a specific test file
bun test tests/e2e/phoenix.test.ts
```

In CI, e2e tests **skip silently** when the required env var is not set —
so a credentials-less CI passes. Locally, set the env vars for whichever
backends you want to verify against.

## Required env vars per test

| Test | Required env vars | Notes |
|---|---|---|
| `phoenix.test.ts` | `PHOENIX_OTEL_ENDPOINT` | Tracing endpoint, e.g. `http://localhost:6006`. Optional: `PHOENIX_API_KEY`. |
| `braintrust.test.ts` | `BRAINTRUST_API_KEY` | Optional: `BRAINTRUST_PROJECT` (default: `agent-otel-e2e`). |
| `slack.test.ts` | `SLACK_WEBHOOK_URL` | An incoming webhook URL. Test posts a single message. |
| `s3.test.ts` | `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Optional: `S3_ENDPOINT` (for R2/MinIO), `S3_REGION` (default `us-east-1`), `S3_FORCE_PATH_STYLE`. |
| `otlp.test.ts` | `OTLP_ENDPOINT` | Any OTLP/HTTP endpoint. Same Phoenix endpoint works. |

## What each test verifies

- **Phoenix**: posts a span via the `phoenix` sink and queries Phoenix's
  GraphQL API to confirm the span landed with the expected trace ID and
  attributes.
- **Braintrust**: posts a span via the `braintrust` sink to project logs.
  Currently fire-and-forget — Braintrust's read API is rate-limited; we
  verify HTTP 200 from ingest.
- **Slack**: posts via the `slack` sink and verifies Slack's webhook
  acknowledged with HTTP 200. We don't read the channel back.
- **S3**: uploads spans via the `s3` sink, downloads the resulting object,
  verifies gzip decompression and JSONL line count match what was sent.
  Cleans up the test object afterward.
- **OTLP (generic)**: posts via the generic `otlp` sink and verifies the
  endpoint returned 2xx.

## Why we don't always read back

Some backends provide easy verification (S3 — fetch the object;
Phoenix — GraphQL). Others have rate-limited read APIs that are
expensive or slow to query (Braintrust, vendor SaaS in general).
For those we verify the **ingest contract** (HTTP success + correct
payload shape) rather than the **storage contract** (we sent X, the
backend has X). That tradeoff is acceptable for a v0.x package — the
ingest path is what we own; storage is the vendor's job.

## Adding a new e2e test

```ts
// tests/e2e/myvendor.test.ts
import { test, expect } from 'bun:test';
import { skipIfMissing } from './_helpers';

const endpoint = skipIfMissing('MYVENDOR_ENDPOINT');
const apiKey   = skipIfMissing('MYVENDOR_API_KEY');

test('myvendor sink posts a span', async () => {
  if (!endpoint || !apiKey) return; // skipIfMissing already logged
  // ... real test ...
});
```

`skipIfMissing(name)` returns the env var value if set, or `undefined`
and logs a one-line skip message. Tests that depend on multiple env vars
should bail at the top so the test body doesn't have to handle missing
creds piecemeal.
