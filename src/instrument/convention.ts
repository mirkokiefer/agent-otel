/**
 * Convention mode — controls which attribute name set(s) instrumentations
 * emit. Three modes, matching the pattern OpenTelemetry uses for its
 * HTTP semconv migration via `OTEL_SEMCONV_STABILITY_OPT_IN`.
 *
 *   openinference  — only `llm.*` / `openinference.span.kind` (legacy)
 *   dup            — both name sets (default; widest backend compatibility)
 *   gen_ai         — only `gen_ai.*` (OTel-GenAI-native consumers)
 *
 * Override via env var or programmatic option:
 *
 *   OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_dup                # → dup
 *   OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental # → gen_ai
 *   (unset / anything else)                                  # → openinference
 *
 *   instrument(client, { conventionMode: 'dup' })           # → dup (per-client)
 *
 * Default is `dup` so existing OpenInference consumers (Phoenix) keep
 * rendering while OTel-GenAI-native consumers (Langfuse, DataDog,
 * Honeycomb) pick up `gen_ai.*` for free.
 */

export type ConventionMode = 'openinference' | 'dup' | 'gen_ai';

const DEFAULT_MODE: ConventionMode = 'dup';

/**
 * Read the convention mode from `OTEL_SEMCONV_STABILITY_OPT_IN`. The env
 * var is comma-separated per OTel convention — we look for the GenAI
 * tokens specifically and ignore unrelated values (e.g. `http`).
 */
export function readConventionMode(): ConventionMode {
  const raw = (typeof process !== 'undefined' && process.env?.OTEL_SEMCONV_STABILITY_OPT_IN) || '';
  const tokens = raw.split(',').map((s) => s.trim());
  if (tokens.includes('gen_ai_latest_experimental')) return 'gen_ai';
  if (tokens.includes('gen_ai_dup')) return 'dup';
  if (tokens.includes('openinference')) return 'openinference';
  return DEFAULT_MODE;
}

/**
 * Resolve the effective mode for an instrumentation call.
 * Programmatic option wins over env var.
 */
export function resolveConventionMode(opts?: { conventionMode?: ConventionMode }): ConventionMode {
  return opts?.conventionMode ?? readConventionMode();
}

/** True when the mode should emit OpenInference (`llm.*`) attributes. */
export function emitOpenInference(mode: ConventionMode): boolean {
  return mode === 'openinference' || mode === 'dup';
}

/** True when the mode should emit OTel-GenAI (`gen_ai.*`) attributes. */
export function emitGenAI(mode: ConventionMode): boolean {
  return mode === 'gen_ai' || mode === 'dup';
}
