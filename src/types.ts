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
 * Match expression for a routing rule or query filter.
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
 *   - `MatchOp` discriminated union for and/or/not/substring/regex
 *
 * The router treats top-level keys `kind`, `status_code`, `name`, `span_kind`
 * specially (they refer to fields on RoutedSpan, not nested attributes).
 * Every other key is interpreted as a (possibly dotted) attribute path.
 */
export type MatchSpec =
  | '*'
  | Record<string, string | number | boolean>
  | Array<'*' | Record<string, string | number | boolean> | MatchOp>
  | MatchOp;

/**
 * Composable match operators.
 *
 * Built on top of plain MatchSpec via the `and`, `or`, `not`, `substring`,
 * `regex` constructors in `filters.ts`. Useful when an agent constructs
 * queries dynamically and needs richer composition than flat AND-of-keys.
 */
export type MatchOp =
  | { op: 'and'; specs: MatchSpec[] }
  | { op: 'or'; specs: MatchSpec[] }
  | { op: 'not'; spec: MatchSpec }
  | { op: 'substring'; key: string; value: string; ignoreCase?: boolean }
  | { op: 'regex'; key: string; pattern: string; flags?: string };

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
// Inspectable: optional read-side capability
// ---------------------------------------------------------------------------

/**
 * Options for queries that scan many spans.
 *
 * `where` is an optional MatchSpec the caller AND-composes onto every
 * query — meant for auth-scoping (e.g. embedders pass `{ 'org.id': X }`
 * to ensure no caller can ever see other orgs' spans, regardless of the
 * `filter` they supply). Implementations MUST AND `where` with `filter`
 * before evaluating.
 */
export interface QueryOptions {
  /** AND-composed scope filter, applied non-bypassably. */
  where?: MatchSpec;
  /** Max rows returned. Default: 100. */
  limit?: number;
  /** Skip the first N rows (for pagination). Default: 0. */
  offset?: number;
  /** Order: 'recent' (default — start_time DESC) or 'oldest'. */
  order?: 'recent' | 'oldest';
}

/** Aggregate stats over a sink's contents (or a filtered subset). */
export interface TraceStats {
  spanCount: number;
  traceCount: number;
  errorCount: number;
  /** Mean duration across spans in ms. `null` if no spans. */
  avgDurationMs: number | null;
  /** Sum of `llm.cost.total` attributes when present. */
  totalCost: number | null;
  /** Earliest start_time seen, ISO string. `null` if no spans. */
  earliestStart: string | null;
  /** Latest start_time seen, ISO string. `null` if no spans. */
  latestStart: string | null;
}

/**
 * Optional capability — a sink that can be queried.
 *
 * Memory and Postgres sinks implement this. Slack/Jsonl/Otlp/Phoenix don't
 * (they're write-only). `Router.query()` looks for this capability on the
 * named sink and delegates.
 *
 * The `where` option in QueryOptions is the auth-scope mechanism — embedders
 * (Daslab, etc.) supply a scope MatchSpec and the implementation AND-composes
 * it with every query so callers cannot bypass it.
 */
export interface Inspectable {
  /** Find spans matching `filter`. */
  findSpans(filter: MatchSpec, opts?: QueryOptions): Promise<RoutedSpan[]> | RoutedSpan[];
  /** Lookup a single span by id. */
  getSpan(spanId: string, opts?: { where?: MatchSpec }): Promise<RoutedSpan | undefined> | RoutedSpan | undefined;
  /** All spans for a given trace_id. */
  getTrace(traceId: string, opts?: { where?: MatchSpec }): Promise<RoutedSpan[]> | RoutedSpan[];
  /** Aggregate stats over the sink's contents (or a filtered subset). */
  stats(filter?: MatchSpec, opts?: { where?: MatchSpec }): Promise<TraceStats> | TraceStats;
}

/** True if `sink` implements the Inspectable capability. */
export function isInspectable(sink: Sink): sink is Sink & Inspectable {
  const s = sink as Sink & Partial<Inspectable>;
  return typeof s.findSpans === 'function'
      && typeof s.getSpan    === 'function'
      && typeof s.getTrace   === 'function'
      && typeof s.stats      === 'function';
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
