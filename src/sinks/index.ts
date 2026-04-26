/**
 * Barrel export for built-in sinks.
 *
 *   import { jsonl, memory, otlp, phoenix, braintrust, slack } from 'agent-otel/sinks';
 */

export { memory,     type MemorySink, type MemorySinkOptions } from './memory.js';
export { jsonl,      type JsonlSinkOptions }                   from './jsonl.js';
export { otlp,       type OtlpSinkOptions }                    from './otlp.js';
export { phoenix,    type PhoenixSinkOptions }                 from './phoenix.js';
export { braintrust, type BraintrustSinkOptions }              from './braintrust.js';
export { slack,      type SlackSinkOptions, type SlackMessage } from './slack.js';
export { s3,         type S3SinkOptions }                       from './s3.js';
