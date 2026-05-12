/**
 * Generic OTLP/HTTP sink — POSTs spans to any standard OTLP endpoint.
 *
 * Two wire formats supported:
 *
 *   - **`'protobuf'`** (default) — uses the official
 *     `@opentelemetry/exporter-trace-otlp-proto` package under the hood.
 *     This is what Phoenix, Datadog, Honeycomb, Tempo, Jaeger v2, and
 *     most production OTLP receivers accept. Recommended.
 *
 *   - **`'json'`** — hand-rolled JSON serializer, no official exporter
 *     dependency. Lighter install. Works with the subset of OTLP receivers
 *     that accept `application/json` (some hosted services, but NOT
 *     Phoenix, NOT most collectors). Use only if your backend explicitly
 *     accepts OTLP/JSON.
 *
 * `@opentelemetry/exporter-trace-otlp-proto` is an OPTIONAL peer dep —
 * required only when `format: 'protobuf'` (the default). Lazy-imported.
 */

import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { SpanContext } from '@opentelemetry/api';
import { SpanKind as OTelSpanKind, SpanStatusCode } from '@opentelemetry/api';

import type { RoutedSpan, Sink, SpanKind, StatusCode, AttrValue } from '../types.js';

export interface OtlpSinkOptions {
  /** Full URL to the OTLP/HTTP traces endpoint, e.g. https://api.honeycomb.io/v1/traces */
  url: string;
  /** Custom headers (auth tokens, project ids, etc.). */
  headers?: Record<string, string>;
  /** Number of spans to batch before flushing. Default: 50. */
  batchSize?: number;
  /** Max ms between flushes regardless of batch size. Default: 2000. */
  flushIntervalMs?: number;
  /** Custom name (in case you want multiple OTLP sinks). */
  name?: string;
  /**
   * Wire format. 'protobuf' (default) uses the official OTel exporter and
   * works with virtually all OTLP receivers. 'json' is the hand-rolled
   * fallback for backends that explicitly accept OTLP/JSON.
   */
  format?: 'protobuf' | 'json';
}

const KIND_NUM: Record<SpanKind, number> = {
  INTERNAL: 1, SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5,
};
const STATUS_NUM: Record<StatusCode, number> = {
  UNSET: 0, OK: 1, ERROR: 2,
};
const KIND_ENUM: Record<SpanKind, OTelSpanKind> = {
  INTERNAL: OTelSpanKind.INTERNAL,
  SERVER:   OTelSpanKind.SERVER,
  CLIENT:   OTelSpanKind.CLIENT,
  PRODUCER: OTelSpanKind.PRODUCER,
  CONSUMER: OTelSpanKind.CONSUMER,
};
const STATUS_ENUM: Record<StatusCode, SpanStatusCode> = {
  UNSET: SpanStatusCode.UNSET,
  OK:    SpanStatusCode.OK,
  ERROR: SpanStatusCode.ERROR,
};

// ---------------------------------------------------------------------------
// JSON serializer (legacy / fallback)
// ---------------------------------------------------------------------------

function toAnyValue(v: AttrValue): unknown {
  if (typeof v === 'string')  return { stringValue: v };
  if (typeof v === 'number')  return Number.isInteger(v) ? { intValue: v } : { doubleValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (Array.isArray(v))       return { arrayValue: { values: v.map(toAnyValue) } };
  return { stringValue: String(v) };
}
function toKeyValues(attrs: Record<string, AttrValue | undefined>) {
  const out: Array<{ key: string; value: unknown }> = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    out.push({ key: k, value: toAnyValue(v) });
  }
  return out;
}
function toOtlpJsonPayload(spans: RoutedSpan[]) {
  if (spans.length === 0) return null;
  const buckets = new Map<string, Map<string, { resource: any; scope: any; spans: any[] }>>();
  for (const s of spans) {
    const resKey = JSON.stringify(s.resource);
    const scopeKey = `${s.scope.name}@${s.scope.version ?? ''}`;
    let scopeMap = buckets.get(resKey);
    if (!scopeMap) buckets.set(resKey, scopeMap = new Map());
    let bucket = scopeMap.get(scopeKey);
    if (!bucket) {
      scopeMap.set(scopeKey, bucket = {
        resource: { attributes: toKeyValues(s.resource) },
        scope:    { name: s.scope.name, version: s.scope.version },
        spans:    [],
      });
    }
    bucket.spans.push({
      traceId: s.traceId,
      spanId:  s.spanId,
      parentSpanId: s.parentSpanId,
      name: s.name,
      kind: KIND_NUM[s.kind],
      startTimeUnixNano: String(s.startTimeUnixNano),
      endTimeUnixNano:   String(s.endTimeUnixNano),
      attributes: toKeyValues(s.attributes),
      events: s.events.map(e => ({
        name: e.name,
        timeUnixNano: String(e.timeUnixNano),
        attributes: toKeyValues(e.attributes ?? {}),
      })),
      links: s.links.map(l => ({
        traceId: l.traceId,
        spanId:  l.spanId,
        attributes: toKeyValues(l.attributes ?? {}),
      })),
      status: { code: STATUS_NUM[s.status.code], message: s.status.message },
    });
  }
  const resourceSpans: any[] = [];
  for (const scopeMap of buckets.values()) {
    const scopeSpans = [...scopeMap.values()].map(b => ({ scope: b.scope, spans: b.spans }));
    const first = scopeMap.values().next().value!;
    resourceSpans.push({ resource: first.resource, scopeSpans });
  }
  return { resourceSpans };
}

// ---------------------------------------------------------------------------
// Proto serializer (uses official OTel exporter)
// ---------------------------------------------------------------------------

/**
 * Convert a RoutedSpan into a ReadableSpan-like object accepted by the
 * official OTLPTraceExporter. We don't need a fully-featured ReadableSpan
 * instance — just an object whose duck type matches what the proto
 * serializer reads.
 */
function toReadableSpan(s: RoutedSpan): ReadableSpan {
  const startSec  = Math.floor(s.startTimeUnixNano / 1e9);
  const startNano = s.startTimeUnixNano - startSec * 1e9;
  const endSec    = Math.floor(s.endTimeUnixNano / 1e9);
  const endNano   = s.endTimeUnixNano - endSec * 1e9;

  const ctx: SpanContext = {
    traceId: s.traceId,
    spanId:  s.spanId,
    traceFlags: 1,
  };

  const attributes: Record<string, AttrValue> = {};
  for (const [k, v] of Object.entries(s.attributes)) {
    if (v !== undefined) attributes[k] = v;
  }

  return {
    name: s.name,
    kind: KIND_ENUM[s.kind],
    spanContext: () => ctx,
    parentSpanContext: s.parentSpanId
      ? { traceId: s.traceId, spanId: s.parentSpanId, traceFlags: 1 }
      : undefined,
    startTime: [startSec, startNano] as [number, number],
    endTime:   [endSec, endNano]     as [number, number],
    status: {
      code: STATUS_ENUM[s.status.code],
      message: s.status.message,
    },
    attributes: attributes as any,
    links: s.links.map(l => ({
      context: { traceId: l.traceId, spanId: l.spanId, traceFlags: 1 },
      attributes: l.attributes as any,
    })),
    events: s.events.map(e => {
      const evSec  = Math.floor(e.timeUnixNano / 1e9);
      const evNano = e.timeUnixNano - evSec * 1e9;
      return {
        name: e.name,
        time: [evSec, evNano] as [number, number],
        attributes: e.attributes as any,
      };
    }),
    duration: [endSec - startSec, endNano - startNano] as [number, number],
    ended: true,
    resource: { attributes: s.resource as any, asyncAttributesPending: false } as any,
    instrumentationScope: { name: s.scope.name, version: s.scope.version } as any,
    instrumentationLibrary: { name: s.scope.name, version: s.scope.version } as any,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as unknown as ReadableSpan;
}

// ---------------------------------------------------------------------------
// Sink
// ---------------------------------------------------------------------------

export function otlp(opts: OtlpSinkOptions): Sink {
  const batchSize = opts.batchSize ?? 50;
  const flushIntervalMs = opts.flushIntervalMs ?? 2000;
  const format = opts.format ?? 'protobuf';
  const headers = { ...(opts.headers ?? {}) };

  let pending: RoutedSpan[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let protoExporter: any = null;

  async function ensureProtoExporter() {
    if (protoExporter) return protoExporter;
    let mod: any;
    try {
      mod = await import('@opentelemetry/exporter-trace-otlp-proto');
    } catch {
      throw new Error(
        '[agent-otel/sinks/otlp] format=protobuf requires @opentelemetry/exporter-trace-otlp-proto. ' +
        'Run `npm install @opentelemetry/exporter-trace-otlp-proto`, or set format: "json" if your backend accepts OTLP/JSON.',
      );
    }
    protoExporter = new mod.OTLPTraceExporter({ url: opts.url, headers });
    return protoExporter;
  }

  async function sendProto(batch: RoutedSpan[]) {
    const exporter = await ensureProtoExporter();
    const readable = batch.map(toReadableSpan);
    await new Promise<void>((resolve, reject) => {
      exporter.export(readable, (result: any) => {
        if (result?.code === 0 || result?.code === undefined) resolve();
        else reject(new Error(`OTLP proto export failed: ${JSON.stringify(result)}`));
      });
    });
  }

  async function sendJson(batch: RoutedSpan[]) {
    const payload = toOtlpJsonPayload(batch);
    if (!payload) return;
    const res = await fetch(opts.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '<no body>');
      throw new Error(`OTLP/JSON ${res.status} from ${opts.url}: ${body.slice(0, 500)}`);
    }
  }

  async function drain() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    if (format === 'protobuf') await sendProto(batch);
    else                       await sendJson(batch);
  }

  function scheduleFlush() {
    if (timer) return;
    timer = setTimeout(() => {
      drain().catch(err => console.error('[agent-otel/sinks/otlp] flush failed:', err));
    }, flushIntervalMs);
    if (typeof timer === 'object' && timer && 'unref' in timer) (timer as any).unref();
  }

  return {
    name: opts.name ?? 'otlp',
    async consume(span) {
      pending.push(span);
      if (pending.length >= batchSize) {
        await drain();
      } else {
        scheduleFlush();
      }
    },
    async flush()    { await drain(); },
    async shutdown() {
      await drain();
      if (protoExporter && protoExporter.shutdown) await protoExporter.shutdown();
    },
  };
}
