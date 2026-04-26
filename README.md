# `@daslab/agent-otel`

> The OTel router for agent telemetry.
>
> **One emit, fanout to any eval, training, observability, or archival sink — without rewriting per-vendor SDK code.**

`agent-otel` is a TypeScript-native OpenTelemetry span router with agent-aware semantic conventions and adapters for the sinks AI teams actually use (Phoenix, Braintrust, OTLP, JSONL, S3, …). Drop it in next to your existing OTel setup; route spans by attribute to whichever sinks you care about; add or remove sinks via config without touching the rest of your code.

```ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { defineRouter } from '@daslab/agent-otel';
import { jsonl, otlp, memory } from '@daslab/agent-otel/sinks';

const router = defineRouter({
  sinks: {
    archive: jsonl({ path: './traces.jsonl' }),
    apm:     otlp({ url: 'https://api.honeycomb.io/v1/traces',
                    headers: { 'x-honeycomb-team': process.env.HC_KEY! } }),
    debug:   memory(),  // for tests + replay
  },
  rules: [
    // Everything → archival
    { match: '*',                          to: ['archive']         },
    // LLM spans → APM (which has gen_ai support)
    { match: { 'gen_ai.system': '*' },     to: ['apm']             },
    // Errors → APM only
    { match: { 'status_code': 'ERROR' },   to: ['apm']             },
    // High-cost LLM calls → debug snapshot
    { match: { 'llm.cost.total': '>0.1' }, to: ['debug']           },
  ],
});

const sdk = new NodeSDK({ spanProcessors: [router.asSpanProcessor()] });
sdk.start();
```

That's it. Your existing `tracer.startSpan(...)` calls now fan out per the rules.

---

## Why this exists

Building an agent today means integrating **separately** with: a tracing tool, an APM tool, an eval platform, a training-data exporter, an audit log, and probably a vendor-specific log sink for whatever sneaky thing you're doing. Each integration uses that vendor's SDK, that vendor's data shape, that vendor's auth pattern. Switching providers means rewriting code. Adding a sink means rewriting code.

The OpenTelemetry Collector solves this for traditional APM but is:
- A Go binary configured in YAML, not a TypeScript library
- Not agent-aware (doesn't know `gen_ai.*`, `daslab.reward.*`, `llm.cost.total`)
- Missing exporters for the agent-specific sinks (Phoenix-as-eval-dataset, Braintrust experiments, OpenPipe training data, RL frameworks)

`agent-otel` fills that specific gap: agent-aware OTel routing, in TypeScript, with the sink adapters AI teams need.

## Design principles

1. **OTel-canonical input.** You emit standard OTel spans. The router is just a `SpanProcessor`. No new SDK to learn.
2. **Sink adapters, not lock-in.** Every sink is an adapter that takes OTel spans and translates to that sink's specific format. Adding a new sink doesn't change your application code.
3. **Attribute-based routing.** Rules match on span attributes (`gen_ai.system`, `db.system`, `status_code`, etc.). Agent semantic conventions are first-class.
4. **No required storage.** The router is a streaming pipeline. If you want durability, plug in a storage sink. Most teams use multiple.
5. **Bring your own backends.** Phoenix and Braintrust adapters are reference implementations. Anyone can write a new sink in ~50 lines.

## What's in the box

### Core router

- `defineRouter({ sinks, rules })` — declarative configuration
- `router.asSpanProcessor()` — drop-in OTel SpanProcessor
- Attribute matching: equality, glob, comparison (`>`, `<`, `>=`, `<=`), presence
- Multi-rule fanout (a span can match multiple rules)
- Backpressure-aware (sinks signal slow ingest, router drops or queues per config)

### Reference sinks

| Sink | Module | Status |
|---|---|---|
| Generic OTLP/HTTP | `@daslab/agent-otel/sinks/otlp` | ✅ v0.0.1 |
| In-memory (tests) | `@daslab/agent-otel/sinks/memory` | ✅ v0.0.1 |
| Local JSONL file | `@daslab/agent-otel/sinks/jsonl` | ✅ v0.0.1 |
| Console pretty-printer | `@daslab/agent-otel/sinks/console` | planned |
| Phoenix (eval datasets) | `@daslab/agent-otel/sinks/phoenix` | planned |
| Braintrust (experiments) | `@daslab/agent-otel/sinks/braintrust` | planned |
| Sentry (errors only) | `@daslab/agent-otel/sinks/sentry` | planned |
| S3/GCS archival | `@daslab/agent-otel/sinks/object-store` | planned |
| OpenPipe (training) | `@daslab/agent-otel/sinks/openpipe` | planned |

### Agent semantic conventions

Built-in support for the attributes AI teams actually use:
- **`gen_ai.*`** — OpenInference / OTel GenAI WG conventions (model, system, token counts, cost, input/output messages)
- **`db.*`, `http.*`, `code.*`, `vcs.*`** — standard OTel conventions for tools
- **`daslab.*`** — extended conventions for plan steps, rewards, orchestrator type, content-addressed state

## Status

**v0.0.1 — pre-alpha.** Scaffolding, core router, three reference sinks. Used internally by  for routing agent telemetry to multiple backends. API will change. Open issues, send PRs.

## License

MIT.
