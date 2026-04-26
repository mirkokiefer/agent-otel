/**
 * Generic OTLP/HTTP sink — POSTs spans to any standard OTLP endpoint.
 *
 * Use this for backends that already accept OTLP natively (Phoenix,
 * Honeycomb, Datadog, Tempo, Jaeger v2, Braintrust, LangSmith, …).
 *
 * Implementation note: we don't pull in the heavyweight
 * `@opentelemetry/exporter-trace-otlp-proto` package as a peer dep.
 * Instead we serialize RoutedSpan into the OTLP/JSON wire format
 * (lighter, no protobuf codegen). The OTLP receivers we care about all
 * accept JSON. Teams that need protobuf can swap to the official
 * exporter and wire it up themselves.
 */

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
}

const KIND_NUM: Record<SpanKind, number> = {
  INTERNAL: 1, SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5,
};
const STATUS_NUM: Record<StatusCode, number> = {
  UNSET: 0, OK: 1, ERROR: 2,
};

function toAnyValue(v: AttrValue): unknown {
  if (typeof v === 'string')  return { stringValue: v };
  if (typeof v === 'number')  return Number.isInteger(v) ? { intValue: v } : { doubleValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(toAnyValue) } };
  }
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

/**
 * Group spans into the nested {resource → scope → spans} OTLP structure.
 * For simplicity we flatten everything into a single resource block when
 * resource attributes match. Most spans in a single process share a
 * resource (service.name etc.) so this collapses well.
 */
function toOtlpPayload(spans: RoutedSpan[]) {
  if (spans.length === 0) return null;

  // Group by (stringified resource attrs) → (scope name+version) → spans
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
    const scopeSpans = [...scopeMap.values()].map(b => ({
      scope: b.scope,
      spans: b.spans,
    }));
    // All buckets in a scopeMap share a resource (same key); take the first.
    const first = scopeMap.values().next().value!;
    resourceSpans.push({ resource: first.resource, scopeSpans });
  }
  return { resourceSpans };
}

export function otlp(opts: OtlpSinkOptions): Sink {
  const batchSize = opts.batchSize ?? 50;
  const flushIntervalMs = opts.flushIntervalMs ?? 2000;
  const headers = { 'content-type': 'application/json', ...(opts.headers ?? {}) };

  let pending: RoutedSpan[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function send(batch: RoutedSpan[]) {
    const payload = toOtlpPayload(batch);
    if (!payload) return;
    const res = await fetch(opts.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '<no body>');
      throw new Error(`OTLP ${res.status} from ${opts.url}: ${body.slice(0, 500)}`);
    }
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
    timer = setTimeout(() => { drain().catch(err => console.error('[agent-otel] otlp flush failed:', err)); }, flushIntervalMs);
    // Don't keep the process alive just for this timer.
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
    async shutdown() { await drain(); },
  };
}
