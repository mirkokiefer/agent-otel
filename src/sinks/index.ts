/**
 * Barrel export for built-in sinks.
 *
 *   import { jsonl, memory, otlp } from '@daslab/agent-otel/sinks';
 */

export { memory, type MemorySink, type MemorySinkOptions } from './memory.js';
export { jsonl, type JsonlSinkOptions } from './jsonl.js';
export { otlp, type OtlpSinkOptions } from './otlp.js';
