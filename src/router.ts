/**
 * The Router — core of `@daslab/agent-otel`.
 *
 * Receives RoutedSpan instances, evaluates routing rules, fans out to
 * matched sinks. Exposes an OTel SpanProcessor view via `asSpanProcessor()`
 * so the router slots into any existing OTel SDK setup.
 */

import type {
  ReadableSpan,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { SpanKind as OTelSpanKind, SpanStatusCode } from '@opentelemetry/api';

import { matches } from './filters.js';
import type {
  Attributes,
  AttrValue,
  RoutedSpan,
  RouterConfig,
  SpanKind,
  StatusCode,
} from './types.js';

/**
 * OTel's AttributeValue allows (string|null|undefined)[] etc.; ours is
 * stricter. Coerce: drop nulls/undefineds inside arrays, leave scalars
 * untouched. Sinks see clean homogeneous arrays.
 */
function normalizeAttrs(attrs: Record<string, unknown> | undefined): Attributes {
  const out: Attributes = {};
  if (!attrs) return out;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      const filtered = v.filter(x => x !== null && x !== undefined);
      if (filtered.length === 0) continue;
      out[k] = filtered as AttrValue;
    } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    }
  }
  return out;
}

const KIND_NAMES: Record<OTelSpanKind, SpanKind> = {
  [OTelSpanKind.INTERNAL]: 'INTERNAL',
  [OTelSpanKind.SERVER]:   'SERVER',
  [OTelSpanKind.CLIENT]:   'CLIENT',
  [OTelSpanKind.PRODUCER]: 'PRODUCER',
  [OTelSpanKind.CONSUMER]: 'CONSUMER',
};

const STATUS_NAMES: Record<SpanStatusCode, StatusCode> = {
  [SpanStatusCode.UNSET]: 'UNSET',
  [SpanStatusCode.OK]:    'OK',
  [SpanStatusCode.ERROR]: 'ERROR',
};

/**
 * Convert an OTel SDK ReadableSpan to a RoutedSpan plain-object snapshot.
 *
 * `hrtime` is OTel's [seconds, nanoseconds] tuple; we collapse it into a
 * single Unix-epoch nanosecond integer for serialization sanity.
 */
function toRouted(span: ReadableSpan): RoutedSpan {
  const startNano = span.startTime[0] * 1e9 + span.startTime[1];
  const endNano   = span.endTime[0]   * 1e9 + span.endTime[1];

  return {
    traceId: span.spanContext().traceId,
    spanId:  span.spanContext().spanId,
    parentSpanId: span.parentSpanContext?.spanId,

    name:   span.name,
    kind:   KIND_NAMES[span.kind] ?? 'INTERNAL',
    status: {
      code:    STATUS_NAMES[span.status.code] ?? 'UNSET',
      message: span.status.message,
    },

    startTimeUnixNano: startNano,
    endTimeUnixNano:   endNano,
    durationMs: (endNano - startNano) / 1e6,

    attributes: normalizeAttrs(span.attributes),
    events: span.events.map(e => ({
      name: e.name,
      attributes: normalizeAttrs(e.attributes),
      timeUnixNano: e.time[0] * 1e9 + e.time[1],
    })),
    links: span.links.map(l => ({
      traceId: l.context.traceId,
      spanId:  l.context.spanId,
      attributes: normalizeAttrs(l.attributes),
    })),

    resource: normalizeAttrs(span.resource?.attributes),
    scope: {
      name:    span.instrumentationScope.name,
      version: span.instrumentationScope.version,
    },
  };
}

export class Router {
  constructor(private readonly config: RouterConfig) {
    // Validate sink ids referenced by rules
    for (const rule of config.rules) {
      for (const id of rule.to) {
        if (!config.sinks[id]) {
          throw new Error(
            `[agent-otel] Routing rule${rule.name ? ` "${rule.name}"` : ''} references unknown sink "${id}". Defined sinks: ${Object.keys(config.sinks).join(', ') || '(none)'}.`,
          );
        }
      }
    }
  }

  /**
   * Route a single span. Computes the union of sink ids across all matching
   * rules and dispatches the span to each. Sink failures are logged (or
   * thrown if config.onSinkError === 'throw').
   */
  async route(span: RoutedSpan): Promise<void> {
    const targetIds = new Set<string>();
    for (const rule of this.config.rules) {
      if (matches(span, rule.match)) {
        for (const id of rule.to) targetIds.add(id);
      }
    }

    if (targetIds.size === 0) return;

    const errors: Array<{ sinkId: string; err: unknown }> = [];
    await Promise.all(
      [...targetIds].map(async id => {
        const sink = this.config.sinks[id]!;
        try {
          await sink.consume(span);
        } catch (err) {
          errors.push({ sinkId: id, err });
        }
      }),
    );

    if (errors.length > 0) {
      const onError = this.config.onSinkError ?? 'log';
      for (const { sinkId, err } of errors) {
        const msg = err instanceof Error ? err.message : String(err);
        if (onError === 'throw') {
          throw new Error(`[agent-otel] sink "${sinkId}" failed: ${msg}`);
        }
        console.error(`[agent-otel] sink "${sinkId}" failed: ${msg}`);
      }
    }
  }

  /** Flush all sinks. */
  async flush(): Promise<void> {
    await Promise.all(
      Object.values(this.config.sinks).map(s => s.flush?.() ?? Promise.resolve()),
    );
  }

  /** Final shutdown: flush + close every sink. */
  async shutdown(): Promise<void> {
    await this.flush();
    await Promise.all(
      Object.values(this.config.sinks).map(s => s.shutdown?.() ?? Promise.resolve()),
    );
  }

  /**
   * Adapt the router as an OTel SpanProcessor so it slots into NodeSDK /
   * BasicTracerProvider configurations alongside any other processors.
   */
  asSpanProcessor(): SpanProcessor {
    const router = this;
    return {
      onStart(_span, _ctx) { /* noop — we route on end */ },
      onEnd(span) {
        // Synchronously schedule routing without awaiting — SpanProcessor
        // contract is fire-and-forget on onEnd. Errors are caught inside.
        router.route(toRouted(span)).catch(err => {
          console.error('[agent-otel] router.route failed:', err);
        });
      },
      async forceFlush() { await router.flush(); },
      async shutdown()   { await router.shutdown(); },
    };
  }
}

/**
 * Construct a Router. Validates that every sink id referenced by a rule
 * exists in `sinks`.
 */
export function defineRouter(config: RouterConfig): Router {
  return new Router(config);
}
