/**
 * E2E: s3 sink → real S3-compatible object storage.
 *
 * Required env:
 *   S3_BUCKET                     bucket name
 *   S3_ACCESS_KEY_ID              access key
 *   S3_SECRET_ACCESS_KEY          secret key
 *
 * Optional env:
 *   S3_ENDPOINT                   custom endpoint (R2, MinIO, ...)
 *   S3_REGION                     default 'us-east-1' (or 'auto' for R2)
 *   S3_FORCE_PATH_STYLE           '1' to enable path-style URLs
 *
 * What we verify:
 *   - The s3 sink uploads spans as a gzipped JSONL object
 *   - We can fetch the object back, decompress, and parse the JSONL
 *   - Line count and per-span content match what we sent
 *   - Cleans up the test object afterward (ListObjects + DeleteObject)
 */

import { test, expect } from 'bun:test';
import { s3 } from '../../src/sinks/s3.js';
import { skipIfMissing, makeTestSpan, randomHex } from './_helpers.js';

const bucket          = skipIfMissing('S3_BUCKET');
const accessKeyId     = skipIfMissing('S3_ACCESS_KEY_ID');
const secretAccessKey = skipIfMissing('S3_SECRET_ACCESS_KEY');
const endpoint        = process.env.S3_ENDPOINT;
const region          = process.env.S3_REGION ?? (endpoint ? 'auto' : 'us-east-1');
const forcePathStyle  = process.env.S3_FORCE_PATH_STYLE === '1';

test('s3 sink — upload, fetch, verify, cleanup', async () => {
  if (!bucket || !accessKeyId || !secretAccessKey) return;

  const testRunId = randomHex(8);
  const prefix = `agent-otel-e2e/${testRunId}/`;

  // Use a deterministic key so we can fetch + clean up afterward
  const key = `${prefix}batch.jsonl.gz`;
  const sink = s3({
    bucket: bucket!,
    region,
    endpoint,
    forcePathStyle: forcePathStyle || undefined,
    credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
    keyFor: () => key,
    batchSize: 10_000,
    flushIntervalMs: 60_000,
  });

  const spans = [
    makeTestSpan({ name: `s3-e2e-${testRunId}-1`, attributes: { 'agent_otel.marker': testRunId, idx: 1 } }),
    makeTestSpan({ name: `s3-e2e-${testRunId}-2`, attributes: { 'agent_otel.marker': testRunId, idx: 2 } }),
    makeTestSpan({ name: `s3-e2e-${testRunId}-3`, attributes: { 'agent_otel.marker': testRunId, idx: 3 } }),
  ];

  for (const span of spans) await sink.consume(span);
  await sink.flush?.();
  await sink.shutdown?.();

  // Fetch the object back (use the same SDK so we exercise the same auth path)
  const { S3Client, GetObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const client = new S3Client({
    region,
    ...(endpoint && { endpoint }),
    ...(forcePathStyle && { forcePathStyle: true }),
    credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
  });

  try {
    const got = await client.send(new GetObjectCommand({ Bucket: bucket!, Key: key }));
    const bytes = await got.Body!.transformToByteArray();

    // Decompress (we wrote gzip)
    const zlib = await import('node:zlib');
    const { promisify } = await import('node:util');
    const gunzip = promisify(zlib.gunzip);
    const decompressed = (await gunzip(Buffer.from(bytes))).toString('utf8');

    const lines = decompressed.trim().split('\n');
    expect(lines).toHaveLength(3);

    const parsed = lines.map(l => JSON.parse(l));
    expect(parsed.map((s: any) => s.name)).toEqual([
      `s3-e2e-${testRunId}-1`,
      `s3-e2e-${testRunId}-2`,
      `s3-e2e-${testRunId}-3`,
    ]);
    expect(parsed.every((s: any) => s.attributes['agent_otel.marker'] === testRunId)).toBe(true);
  } finally {
    // Always clean up
    await client.send(new DeleteObjectCommand({ Bucket: bucket!, Key: key })).catch(() => {});
  }
}, 60_000);
