/**
 * Core types for `@daslab/agent-otel`.
 *
 * The router operates on `RoutedSpan` — a normalized snapshot of an OTel
 * span, taken at the moment the span ends. Sinks consume `RoutedSpan` and
 * translate it into whatever shape their backend wants.
 *
 * RoutedSpan is intentionally a flat plain object (not the OTel SDK's
 * ReadableSpan class) so sinks can serialize it without depending on
 * sdk-trace-base internals.
 */

/** OTel SpanKind names. */
export type SpanKind =
  | 'INTERNAL'
  | 'SERVER'
  | 'CLIENT'
  | 'PRODUCER'
  | 'CONSUMER';

/** OTel StatusCode names. */
export type StatusCode = 'UNSET' | 'OK' | 'ERROR';

/** OTel attribute value types — what `setAttribute` accepts. */
export type AttrValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | boolean[];

/** Attribute bag on a span, attribute, event, or link. */
export type Attributes = Record<string, AttrValue | undefined>;

/** OTel SpanEvent — a structured log entry within a span. */
export interface SpanEvent {
  name: string;
  attributes?: Attributes;
  /** Unix epoch nanoseconds, OTel convention. */
  timeUnixNano: number;
}

/** OTel Span.Link — a non-parent reference to another span. */
export interface SpanLink {
  traceId: string;
  spanId: string;
  attributes?: Attributes;
}

/**
 * Normalized snapshot of an OTel span at end-time.
 *
 * Sinks receive these — never the live OTel Span object. This keeps
 * serialization simple, makes sinks independent of OTel SDK internals,
 * and means RoutedSpan can be persisted to disk / replayed without
 * re-instantiating SDK types.
 */
export interface RoutedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;

  name: string;
  kind: SpanKind;
  status: { code: StatusCode; message?: string };

  /** Unix epoch nanoseconds (OTel convention). */
  startTimeUnixNano: number;
  /** Unix epoch nanoseconds. */
  endTimeUnixNano: number;
  /** Convenience: duration in milliseconds. */
  durationMs: number;

  attributes: Attributes;
  events: SpanEvent[];
  links: SpanLink[];

  /** Resource attributes (service.name, deployment.environment, …). */
  resource: Attributes;

  /** OTel instrumentation scope — usually the tracer name + version. */
  scope: { name: string; version?: string };
}

// ---------------------------------------------------------------------------
// Routing rules
// ---------------------------------------------------------------------------

/**
 * Match expression for a routing rule.
 *
 * Forms:
 *   - `'*'` — match every span
 *   - `{ 'attr.path': '*' }` — match if attribute is present (any value)
 *   - `{ 'attr.path': 'exact' }` — exact string equality
 *   - `{ 'attr.path': '>0.1' }` — numeric comparison (`>`, `<`, `>=`, `<=`, `==`, `!=`)
 *   - `{ kind: 'CLIENT' }` — match span kind
 *   - `{ status_code: 'ERROR' }` — match status code
 *   - Multiple keys are AND'd together
 *   - Pass an array of MatchSpec to OR multiple specs
 *
 * The router treats top-level keys `kind` and `status_code` specially
 * (they refer to fields on RoutedSpan, not nested attributes). Every
 * other key is interpreted as a (possibly dotted) attribute path.
 */
export type MatchSpec =
  | '*'
  | Record<string, string | number | boolean>
  | Array<'*' | Record<string, string | number | boolean>>;

/**
 * A single routing rule. When a span matches `match`, it is fanned out
 * to each sink id in `to`. Multiple rules may match the same span; the
 * union of their target sink ids is the fanout set.
 */
export interface RoutingRule {
  match: MatchSpec;
  to: string[];
  /** Optional human-readable label for logs / error messages. */
  name?: string;
}

// ---------------------------------------------------------------------------
// Sink contract
// ---------------------------------------------------------------------------

/**
 * Every sink — built-in or third-party — implements this minimal contract.
 *
 * - `name` is a short id used in routing rules and logs.
 * - `consume` receives matched spans. May be async; the router awaits it
 *   per-span by default, but sinks can opt into batching internally.
 * - `flush` is called periodically by the router and on shutdown.
 *   Sinks that buffer should drain here.
 * - `shutdown` is called once at process exit. Final flush + close.
 */
export interface Sink {
  name: string;
  consume(span: RoutedSpan): void | Promise<void>;
  flush?(): Promise<void>;
  shutdown?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Router config
// ---------------------------------------------------------------------------

export interface RouterConfig {
  /** Map of sink id → Sink. Ids are referenced by routing rules. */
  sinks: Record<string, Sink>;
  /** Ordered list of routing rules. Multiple rules may match a span. */
  rules: RoutingRule[];
  /**
   * Behavior when a sink throws or rejects.
   * - `'log'` (default): log the error and continue
   * - `'throw'`: rethrow — useful for tests
   */
  onSinkError?: 'log' | 'throw';
}
