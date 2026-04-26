# `agent-otel`

> **The OTel router for agent telemetry.**
> Already paying for Phoenix *and* Braintrust *and* Datadog? Stop writing per-vendor integration code. **One OTel emit, declarative fanout, swap sinks via config.**

🚧 v0.0.2 — APIs may change. Routing real production agent traffic at [Daslab](https://daslab.dev). MIT, no Daslab dependency.

```ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { defineRouter } from 'agent-otel';
import { phoenix, braintrust, slack, jsonl } from 'agent-otel/sinks';

const router = defineRouter({
  sinks: {
    phoenix:    phoenix({ endpoint: process.env.PHOENIX_ENDPOINT, apiKey: process.env.PHOENIX_API_KEY }),
    braintrust: braintrust({ apiKey: process.env.BRAINTRUST_API_KEY!, project: 'support-agent' }),
    alerts:     slack({ webhookUrl: process.env.SLACK_WEBHOOK_URL! }),
    archive:    jsonl({ path: './traces.jsonl' }),
  },
  rules: [
    // Everything → archival
    { match: '*',                          to: ['archive']               },
    // LLM calls → both eval platforms (A/B compare them, then drop one)
    { match: { 'gen_ai.system': '*' },     to: ['phoenix', 'braintrust'] },
    // Expensive LLM calls → ping #ai-cost-watch in Slack
    { match: { 'llm.cost.total': '>1.0' }, to: ['alerts']                },
    // Errors → both Slack AND Braintrust (so eval picks them up)
    { match: { 'status_code': 'ERROR' },   to: ['alerts', 'braintrust']  },
  ],
});

const sdk = new NodeSDK({ spanProcessors: [router.asSpanProcessor()] });
sdk.start();
```

That's it. Your existing `tracer.startSpan(...)` calls now fan out per the rules. Add a sink, drop a sink, change a threshold — config-only, no app-code changes.

---

## What this replaces

You're probably doing some of these by hand right now:

- **Phoenix SDK** for traces. **Braintrust SDK** for evals. **Datadog OTLP** for APM. **Sentry SDK** for errors.
- A custom Slack/Discord script that scrapes logs for "LLM call > $X" alerts.
- A nightly export script that copies a sample of traces to JSONL for fine-tuning later.
- An ad-hoc adapter that reformats traces when you change eval vendors.

`agent-otel` collapses all of that into one OTel emit + a declarative routing config. Same wire format everywhere; backends are just sinks.

## How is this not just OpenInference?

Different layers, both useful, **complementary not competing**:

| | [OpenInference](https://github.com/Arize-ai/openinference) | `agent-otel` |
|---|---|---|
| **What it is** | Spec + auto-instrumentation: wraps Anthropic/OpenAI/LangChain SDK calls so they emit OTel spans with `gen_ai.*` attributes | Router: takes OTel spans (from any source) and fans them out to many sinks per attribute rules |
| **Lives at** | The SDK boundary (input side) | The export boundary (output side) |
| **Wraps** | Specific LLM SDKs | Nothing — consumes any OTel emitter |
| **Output** | One stream of standardized spans | N parallel streams to N backends |
| **Replay** | No | Yes (see below) |
| **Cost-aware sampling** | No | Yes (`'llm.cost.total': '>1.0'`) |
| **Vendor neutrality** | Owned by Arize (Phoenix's company) | Independent |

Use them together. OpenInference makes your Anthropic SDK calls emit a span. `agent-otel` decides that span should go to Phoenix + Slack but not Braintrust.

## How is this not just OTel Collector?

The OTel Collector is the canonical OTLP pipeline for traditional APM. It's a Go binary configured in YAML, with 100+ exporters in contrib. For agent telemetry it falls short on three axes:

1. **Not agent-aware.** The Collector's transform processors don't know `gen_ai.*`, `daslab.reward.*`, or `llm.cost.total` semantically. You'd have to write generic OTTL transforms by hand.
2. **No agent-specific sink adapters.** Phoenix-as-eval-dataset, Braintrust experiments, OpenPipe training data, RL frameworks — none of these have Collector exporters. We ship them (some today, some planned).
3. **Wrong runtime for TypeScript agent teams.** The Collector is a sidecar process to operate; we're a library you `npm install`. Different ergonomic story.

If you already run the Collector for traditional APM, run `agent-otel` alongside it — they don't compete. Many teams will end up doing both.

## Replay — retroactive routing

The unique capability `agent-otel` unlocks: **change your mind about where spans go AFTER you've collected them.** Routing is configuration, not code, so the destinations aren't baked in at emit time.

```ts
import { replay, fromJsonl } from 'agent-otel/replay';

await replay({
  source: fromJsonl('./prod-traces.jsonl'),
  router: defineRouter({
    sinks: { braintrust: braintrust({...}) },
    rules: [{ match: '*', to: ['braintrust'] }],
  }),
});
```

That's it. Take spans you already captured, re-route them through any router config. Concrete workflows this enables — none of which are easy with Phoenix/Braintrust/Datadog/Collector alone:

### Vendor evaluation without a parallel-instrumentation week

You're on Phoenix; you want to evaluate Braintrust before switching. Without replay you'd instrument your agent to dual-write for a week, pay both, wait, decide. With replay: pipe last week's archived JSONL into Braintrust in 30 seconds. Decision before lunch.

### Customer debugging without touching prod

A customer says "my agent broke yesterday at 3:14pm."

```ts
await replay({
  source: fromJsonl('./prod.jsonl'),
  where: s => s.traceId === 'trace_xyz',
  router: defineRouter({
    sinks: { slack: slack({ webhookUrl: DEBUG_CHANNEL }) },
    rules: [{ match: '*', to: ['slack'] }],
  }),
});
```

Every step of that one trace pings you in Slack with attributes pretty-printed. Pure forensics, no prod impact, no re-execution.

### Backfill a sink you just added

Six months of archived traces; today you sign up for OpenPipe to fine-tune. Pipe the archive through an OpenPipe sink — six months of training data backfilled in one command, not from-now-forward only.

### Smoke-test a new routing rule

About to add `{ match: { 'llm.cost.total': '>0.5' }, to: ['cost-alerts'] }`. Will it spam? Replay last week through it with a memory sink. See the actual volume before deploying.

### Why this is unique

- Phoenix/Braintrust/etc. each own their data silo — you can't pipe Phoenix's stored traces into Braintrust without writing per-vendor ETL each time.
- OTel Collector is stateless and push-only; no concept of replay.
- Most tracing tools assume "live or never."

`agent-otel` separates the transport format (OTel) from the routing decisions (rules). You can re-decide destinations indefinitely.

### Future replay flavors

- **Re-execute** — actually re-run the agent with the same inputs, get a fresh trace. Requires a runtime kernel, not just a router. Planned.
- **Counterfactual** — re-execute with one thing swapped (different model, different system prompt). Planned.

## Sinks shipped today

| Sink | Module | What it does |
|---|---|---|
| Phoenix | `agent-otel/sinks/phoenix` | OTLP/HTTP to Phoenix. Self-hosted or cloud. Optional API key. |
| Braintrust | `agent-otel/sinks/braintrust` | OTLP/HTTP to Braintrust. Routes to a project's logs or an experiment. |
| Slack | `agent-otel/sinks/slack` | Posts spans as messages to a Slack incoming webhook. Built-in rate limiting. Pretty default formatter; bring your own. |
| Generic OTLP | `agent-otel/sinks/otlp` | Any OTLP/HTTP endpoint. Works with Honeycomb, Datadog, Tempo, Jaeger, LangSmith, Langfuse, anything that speaks OTLP/JSON. |
| In-memory | `agent-otel/sinks/memory` | JS array. Tests and replay. |
| JSONL file | `agent-otel/sinks/jsonl` | Append per span to a local file. Single-process. |

Planned: Sentry, OpenPipe, console pretty-printer, S3/GCS object-store, generic webhook helper.

## Filter grammar

Match expressions for routing rules. Keys are OTel attribute paths or top-level fields (`kind`, `status_code`).

```ts
{ match: '*' }                                     // every span
{ match: { kind: 'CLIENT' } }                      // top-level field
{ match: { status_code: 'ERROR' } }                // top-level field
{ match: { 'gen_ai.system': '*' } }                // attribute presence
{ match: { 'gen_ai.system': 'anthropic' } }        // exact equality
{ match: { 'llm.cost.total': '>0.1' } }            // numeric: >, <, >=, <=
{ match: { foo: '!=bar' } }                        // explicit inequality
{ match: { foo: '==bar' } }                        // explicit equality
{ match: { a: 'x', b: 'y' } }                      // multiple keys → AND
{ match: [{ a: 'x' }, { b: 'y' }] }                // array → OR
```

Multiple **rules** matching the same span union their target sinks.

## Design principles

1. **OTel-canonical input.** You emit standard OTel spans. The router is just a `SpanProcessor`. No new SDK to learn.
2. **Sink adapters, not lock-in.** Every sink translates OTel spans to that sink's format internally. Change a sink, app code unchanged.
3. **Attribute-based routing.** Rules match on span attributes — agent semantic conventions are first-class.
4. **No required storage.** The router is streaming. Want durability? Plug in a storage sink. Many setups use multiple.
5. **Bring your own backends.** Built-in sinks are reference implementations. Anyone can write a new sink in ~50 lines.

## Status

**v0.0.2 — pre-alpha.** Core router, six reference sinks (memory/jsonl/otlp/phoenix/braintrust/slack), replay primitive (re-route flavor). Used by [Daslab](https://daslab.dev) to route production agent traces. API will change. Open issues, send PRs.

The package is independent — no Daslab dependency, no required Daslab account, no preferred backend. Use it with whatever stack.

## License

MIT.
