/**
 * S3 sink — append spans to S3-compatible object storage.
 *
 * Built for the **canonical archive** pattern: cheap, durable, queryable
 * later via replay. Works with AWS S3, Cloudflare R2, MinIO, Backblaze B2,
 * any S3-API-compatible backend (just set `endpoint`).
 *
 * Each flush writes one object: gzipped JSONL of the batch. Object key is
 * `${prefix}${ISO timestamp}-${randomId}.jsonl.gz`. Concurrent flushes
 * never collide because of the random suffix.
 *
 * Usage:
 *   import { s3 } from 'agent-otel/sinks/s3';
 *
 *   const sink = s3({
 *     bucket: 'my-traces',
 *     region: 'us-east-1',           // for AWS
 *     // for R2:
 *     // endpoint: `https://<account>.r2.cloudflarestorage.com`,
 *     // forcePathStyle: false,
 *     credentials: {
 *       accessKeyId:     process.env.AWS_ACCESS_KEY_ID!,
 *       secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
 *     },
 *   });
 *
 * @aws-sdk/client-s3 is an OPTIONAL peer dependency. Install it only if
 * you use this sink: `npm install @aws-sdk/client-s3`. The import is
 * lazy so users who don't use this sink pay no install or runtime cost.
 */

import type { RoutedSpan, Sink } from '../types.js';

export interface S3SinkOptions {
  /** Bucket name. */
  bucket: string;
  /** AWS region. For non-AWS S3-compatible (R2, MinIO), use 'auto' or any string. */
  region?: string;
  /** Object key prefix. Default: 'spans/'. Trailing slash recommended. */
  prefix?: string;
  /**
   * Custom S3 endpoint URL — required for non-AWS providers:
   *   R2:       https://<account>.r2.cloudflarestorage.com
   *   MinIO:    http://localhost:9000
   *   Backblaze https://s3.<region>.backblazeb2.com
   */
  endpoint?: string;
  /**
   * Use path-style URLs (`{endpoint}/{bucket}/{key}`) instead of virtual-host
   * style (`{bucket}.{endpoint}/{key}`). Required for MinIO; optional for R2.
   */
  forcePathStyle?: boolean;
  /** Credentials. If omitted, the SDK falls back to env vars / IAM roles. */
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /** Spans per object. Default: 1000. Smaller = more objects, larger = bigger blast radius if upload fails. */
  batchSize?: number;
  /** Max ms between flushes regardless of batch size. Default: 60_000. */
  flushIntervalMs?: number;
  /** Gzip the JSONL body before upload. Default: true. */
  gzip?: boolean;
  /** Override sink name (default: 's3'). */
  name?: string;
  /**
   * Optional key generator override. Default returns
   *   `${prefix}${ISO}-${random}.jsonl.gz`
   * Useful for partitioning (date-based prefixes, per-tenant prefixes, etc.).
   */
  keyFor?: (batch: RoutedSpan[]) => string;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function isoStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function s3(opts: S3SinkOptions): Sink {
  const batchSize = opts.batchSize ?? 1000;
  const flushIntervalMs = opts.flushIntervalMs ?? 60_000;
  const useGzip = opts.gzip !== false;
  const prefix = opts.prefix ?? 'spans/';

  let pending: RoutedSpan[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let s3Client: any = null;
  let PutObjectCommand: any = null;

  async function ensureClient() {
    if (s3Client) return;
    let mod: any;
    try {
      mod = await import('@aws-sdk/client-s3');
    } catch (err) {
      throw new Error(
        '[agent-otel/sinks/s3] @aws-sdk/client-s3 is not installed. ' +
        'Run `npm install @aws-sdk/client-s3` (it\'s an optional peer dependency).',
      );
    }
    PutObjectCommand = mod.PutObjectCommand;
    s3Client = new mod.S3Client({
      region: opts.region ?? 'auto',
      ...(opts.endpoint && { endpoint: opts.endpoint }),
      ...(opts.forcePathStyle !== undefined && { forcePathStyle: opts.forcePathStyle }),
      ...(opts.credentials && { credentials: opts.credentials }),
    });
  }

  function defaultKeyFor(_batch: RoutedSpan[]): string {
    return `${prefix}${isoStamp()}-${randomSuffix()}.jsonl${useGzip ? '.gz' : ''}`;
  }

  async function send(batch: RoutedSpan[]) {
    await ensureClient();
    const lines = batch.map(s => JSON.stringify(s) + '\n').join('');
    let body: Buffer | string = lines;
    if (useGzip) {
      const zlib = await import('node:zlib');
      const { promisify } = await import('node:util');
      const gz = promisify(zlib.gzip);
      body = await gz(Buffer.from(lines, 'utf8'));
    }
    const key = (opts.keyFor ?? defaultKeyFor)(batch);
    await s3Client.send(new PutObjectCommand({
      Bucket: opts.bucket,
      Key: key,
      Body: body,
      ContentType: 'application/x-ndjson',
      ...(useGzip && { ContentEncoding: 'gzip' }),
    }));
  }

  async function drain() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    await send(batch);
  }

  function scheduleFlush() {
    if (timer) return;
    timer = setTimeout(() => {
      drain().catch(err => console.error('[agent-otel/sinks/s3] flush failed:', err));
    }, flushIntervalMs);
    if (typeof timer === 'object' && timer && 'unref' in timer) (timer as any).unref();
  }

  return {
    name: opts.name ?? 's3',
    async consume(span) {
      pending.push(span);
      if (pending.length >= batchSize) {
        await drain();
      } else {
        scheduleFlush();
      }
    },
    async flush()    { await drain(); },
    async shutdown() { await drain(); },
  };
}
