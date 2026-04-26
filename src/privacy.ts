/**
 * `agent-otel/privacy` — privacy-preserving routing.
 *
 * Wrap any Sink with PII masking. Vendor sinks see plausible-but-fake
 * values; your canonical archive sink keeps the real data. The bijective
 * map is preserved within the proxy so unmask(reply) → real values works
 * for round-tripping LLM responses.
 *
 * Powered by https://github.com/mirkokiefer/pii-proxy — a separate package
 * that handles the actual masking logic. We're the integration layer
 * between the OTel routing world and the PII masking primitive.
 *
 * Usage:
 *
 *   import { defineRouter } from 'agent-otel';
 *   import { jsonl, phoenix, braintrust } from 'agent-otel/sinks';
 *   import { withPrivacy } from 'agent-otel/privacy';
 *   import { PrivacyProxy } from 'pii-proxy';
 *
 *   const proxy = new PrivacyProxy();
 *
 *   const router = defineRouter({
 *     sinks: {
 *       // CANONICAL ARCHIVE — keeps raw values, you own this data
 *       archive:    jsonl({ path: './canonical.jsonl' }),
 *       // VENDORS — only ever see plausible fakes
 *       phoenix:    withPrivacy(phoenix({ ... }), { proxy }),
 *       braintrust: withPrivacy(braintrust({ ... }), { proxy }),
 *     },
 *     rules: [{ match: '*', to: ['archive', 'phoenix', 'braintrust'] }],
 *   });
 *
 * The same real value always maps to the same fake within the proxy, so
 * an email "mirko@kiefer.com" appearing in 100 spans becomes the same
 * "alex@johnson.net" everywhere. Phoenix/Braintrust dashboards stay
 * readable; the cross-vendor identity preserved is fake-but-consistent.
 */

import { PrivacyProxy } from 'pii-proxy';
import type { Attributes, RoutedSpan, Sink, SpanEvent } from './types.js';

export interface WithPrivacyOptions {
  /**
   * The proxy instance to use. Reusing one instance across multiple
   * `withPrivacy` wrappers ensures the same real value always maps to
   * the same fake across all wrapped sinks.
   *
   * Default: a fresh PrivacyProxy. Each wrapper that omits this gets
   * its own independent map — usually NOT what you want.
   */
  proxy?: PrivacyProxy;

  /**
   * Hard-redact these attribute keys (value replaced with '[redacted]').
   * Use for values that should never leak even as plausible fakes —
   * API keys, auth tokens, secret IDs.
   */
  redactKeys?: string[];

  /**
   * Skip masking for these attribute keys (value passes through unchanged).
   * Use for non-PII keys you don't want pii-proxy's regex detectors to
   * mistake for sensitive data — e.g. tool names that happen to look
   * like UUIDs, or internal trace identifiers you want preserved.
   *
   * Strings or RegExps. RegExps test against the full attribute key.
   */
  passthroughKeys?: (string | RegExp)[];

  /**
   * Also mask the span name (tool name) and status_message.
   * Default: false — span names are usually tool identifiers without PII,
   * and masking them obscures observability.
   */
  maskNames?: boolean;
}

/**
 * Wrap a Sink so spans are PII-masked before consumption.
 *
 * The wrapper is transparent: lifecycle methods (flush, shutdown) pass
 * through to the wrapped sink. Errors propagate normally.
 */
export function withPrivacy(sink: Sink, opts: WithPrivacyOptions = {}): Sink {
  const proxy = opts.proxy ?? new PrivacyProxy();

  return {
    name: `${sink.name}+privacy`,
    async consume(span: RoutedSpan) {
      const masked = maskSpan(span, proxy, opts);
      await sink.consume(masked);
    },
    flush: sink.flush ? () => sink.flush!() : undefined,
    shutdown: sink.shutdown ? () => sink.shutdown!() : undefined,
  };
}

/**
 * Apply masking rules to a single span. Pure function — input span unchanged.
 */
export function maskSpan(
  span: RoutedSpan,
  proxy: PrivacyProxy,
  opts: WithPrivacyOptions = {},
): RoutedSpan {
  const maskedAttributes = maskAttributes(span.attributes, proxy, opts);
  const maskedEvents: SpanEvent[] = span.events.map(e => ({
    name: e.name,
    timeUnixNano: e.timeUnixNano,
    attributes: e.attributes ? maskAttributes(e.attributes, proxy, opts) : e.attributes,
  }));

  return {
    ...span,
    name: opts.maskNames ? proxy.mask(span.name).text : span.name,
    status: opts.maskNames && span.status.message
      ? { ...span.status, message: proxy.mask(span.status.message).text }
      : span.status,
    attributes: maskedAttributes,
    events: maskedEvents,
  };
}

function maskAttributes(
  attrs: Attributes,
  proxy: PrivacyProxy,
  opts: WithPrivacyOptions,
): Attributes {
  // pii-proxy.maskObject walks string values inside any object structure,
  // so dropping `attrs` straight in handles nested-stringified-JSON cases
  // like attributes['input.value'] = '{"email": "..."}'. The string-with-
  // embedded-JSON gets pattern-matched the same way as a flat string.
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    filtered[k] = v;
  }

  // pii-proxy returns { masked, detections }
  const { masked } = proxy.maskObject(filtered);
  const result: Attributes = { ...(masked as Attributes) };

  // Apply hard redactions (these win over masking)
  if (opts.redactKeys) {
    for (const key of opts.redactKeys) {
      if (key in result) result[key] = '[redacted]';
    }
  }

  // Restore passthrough keys from the original (un-mask)
  if (opts.passthroughKeys?.length) {
    for (const key of Object.keys(attrs)) {
      const matched = opts.passthroughKeys.some(p =>
        typeof p === 'string' ? p === key : p.test(key),
      );
      if (matched) result[key] = attrs[key];
    }
  }

  return result;
}

/**
 * Persistence helpers — useful when the proxy lives across processes
 * (e.g. a long-running router that restarts; replay in a different
 * session that needs the original mappings to unmask LLM responses).
 *
 * Map serialization is JSON; persist anywhere (Redis, file, KV, …).
 */
export function exportProxyMap(proxy: PrivacyProxy): string {
  return proxy.getMap().serialize();
}

export function importProxyMap(proxy: PrivacyProxy, data: string): void {
  proxy.loadMap(data);
}

// Re-export PrivacyProxy so the integration is one-stop:
//   import { withPrivacy, PrivacyProxy } from 'agent-otel/privacy';
export { PrivacyProxy };
