# `agent-otel` + `scry`

> **Agent-native observability, in two layers.**
> `agent-otel` — the OTel-native router + sinks + replay (the substrate).
> `scry` — the SDK and CLI an agent uses to query its own traces.

🚧 v0.0.11 — pre-alpha, APIs may change. MIT.

---

`agent-otel` is the substrate: declarative fanout to any number of backends, replay for retroactive rerouting, reversible PII masking. App engineers wire it up the same way whether the consumer is a human, an agent, or both. `scry` is where the agent-first thesis lives: an SDK and CLI for an agent to inspect its own traces in-process or from a shell. Think `kubernetes` + `kubectl` — library and CLI, dual-named on purpose. Phoenix/Braintrust/Langfuse render traces for humans; `scry` gives an agent a query surface over the same data. They compose.

## Install

```bash
npm install agent-otel
# or: bun add agent-otel
```

`scry` ships as a CLI in the same package:

```bash
npx scry --help
# after bun add agent-otel:
bunx scry --help
```

## 60-second install — Anthropic + Braintrust

If you're on `@anthropic-ai/sdk` and Braintrust today, this is the whole setup:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { defineRouter } from 'agent-otel';
import { instrument } from 'agent-otel/anthropic';
import { braintrust, postgres } from 'agent-otel/sinks';
import { withPrivacy, PrivacyProxy } from 'agent-otel/privacy';

// 1. Wire the router → backends
const proxy = new PrivacyProxy();
const router = defineRouter({
  sinks: {
    braintrust: withPrivacy(
      braintrust({ apiKey: process.env.BRAINTRUST_API_KEY!, project: 'support-agent' }),
      { proxy, redactKeys: ['auth.token'] },                // PII never reaches Braintrust
    ),
    archive:    postgres({ url: process.env.DATABASE_URL! }),  // your own escape hatch
  },
  rules: [{ match: '*', to: ['braintrust', 'archive'] }],
});

new NodeSDK({ spanProcessors: [router.asSpanProcessor()] }).start();

// 2. Wrap your Anthropic client. That's it. Every messages.create() now emits
//    a perfect OpenInference span — to Braintrust (masked) AND your archive (raw).
const anthropic = instrument(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }));

const resp = await anthropic.messages.create({
  model: 'claude-sonnet-4-7',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
});
```

What you get for those ~10 lines:
- ✅ Every Anthropic call traced with OpenInference attributes (gen_ai.\*, llm.\*, tool calls flattened)
- ✅ Braintrust dashboards work as before (real evals, real playground), **but with PII masked**
- ✅ Your own Postgres archive — query with `scry trace tree <id>` from the CLI
- ✅ Real production cost and token counts on every span (Sonnet/Opus/Haiku tables built in)
- ✅ Replay any stored call counterfactually (`replayLLMCall`) without re-running your whole agent

E2E tested against the real Anthropic + Braintrust APIs (`tests/e2e/instrument-anthropic.test.ts`, `tests/e2e/privacy-braintrust.test.ts`).

For OpenAI, Vercel AI SDK, Mastra, CrewAI — auto-instrument adapters are next. Today: use OpenInference's per-vendor packages alongside agent-otel's router (they emit OTel; we route OTel; same wire format).

## Router — one OTel emit, declarative fanout

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
    // LLM calls → both eval platforms
    { match: { 'gen_ai.system': '*' },     to: ['phoenix', 'braintrust'] },
    // Expensive LLM calls → ping #ai-cost-watch in Slack
    { match: { 'llm.cost.total': '>1.0' }, to: ['alerts']                },
    // Errors → Slack AND Braintrust (so eval picks them up)
    { match: { 'status_code': 'ERROR' },   to: ['alerts', 'braintrust']  },
  ],
});

const sdk = new NodeSDK({ spanProcessors: [router.asSpanProcessor()] });
sdk.start();
```

Your existing `tracer.startSpan(...)` calls now fan out per the rules. Add a sink, drop a sink, change a threshold — config-only, no app-code changes.

## `scry` — SDK and CLI for agents to query their own traces

Two paths depending on where your agent runs. Pick one or use both:

| Where the agent runs | Reach for | Looks like |
|---|---|---|
| **In-process** (Node.js / Bun, Vercel AI SDK, Anthropic SDK directly) | The **TypeScript SDK** | `sink.findSpans({ status_code: 'ERROR' })` from inside the same process the agent runs in |
| **In a sandbox shell** (E2B, Daytona, your own Docker, anywhere with bash) | The **`scry` CLI** | `scry query --status=ERROR | jq` piped through standard shell tools |

Both surfaces operate on the same data (an `Inspectable` sink — `memory` and `postgres` today, others can implement it). Pick whichever fits where the agent actually lives.

### Programmatic (in-process SDK — most agent code)

For agents running in your Node/Bun process. Import the primitives directly; no shell, no JSON round-trip. Use this when your agent is a function in a TypeScript codebase calling LLMs/tools.

```ts
import { memory } from 'agent-otel/sinks/memory';
import { and, substring } from 'agent-otel/filters';
import { buildTree, causalChain, renderTree } from 'agent-otel/trace-tree';

const sink = memory();
// ... router emits into sink ...

const errors = sink.findSpans(
  and({ status_code: 'ERROR' }, substring('name', 'tool.')),
  { limit: 20 },
);

const tree = buildTree(sink.getTrace(traceId));
console.log(renderTree(tree, { attrs: ['llm.cost.total'] }));
```

### CLI (sandbox shell — and dev terminals)

For agents running in a sandbox shell (E2B, Daytona, etc.) AND for human engineers debugging from a laptop. Composes with shell tools naturally.

**Connect via direct DB or remote endpoint:**

```bash
export SCRY_DB=postgres://localhost/mydb         # direct Postgres (local / dev)
# or for remote:
export SCRY_ENDPOINT=https://scry.example.com
export SCRY_TOKEN=<jwt>
```

Flags `--db`, `--endpoint`, `--token` work per-call too.

**Three one-liners:**

```bash
# Find all ERROR spans in the last 10 minutes, extract span IDs
scry query --status=ERROR --since=10m --output=json | jq '.[] | .spanId'

# Render the full call tree of a job (LLM ↔ tool ↔ DB) as ASCII
scry trace tree 0123abcd...

# Aggregate cost, latency, error rate across a filter
scry stats --attr=gen_ai.system=anthropic
```

Full subcommand reference:

```
scry query       [--status=X] [--kind=X] [--name=X] [--attr=k=v] [--since=10m] [--limit=N]
scry trace get   <trace_id>
scry trace tree  <trace_id> [--attrs=k1,k2]
scry chain       <trace_id> <span_id>      # walk a span back to root: what led to this error?
scry stats       [--status=X] [--attr=k=v]
```

Composes naturally with shell tooling: `scry query --output=json | jq`, `scry stats | awk '$1 > 0.1 {exit 1}'`. No MCP boot, no ceremony.

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

## Already on Braintrust / Phoenix / Langfuse / LangSmith?

Don't switch — **compose**. Each of these is your eval/observability backend; we make them stronger without you re-instrumenting anything.

For an existing Braintrust user (the same pattern works for Phoenix / Langfuse / LangSmith):

```ts
import { defineRouter } from 'agent-otel';
import { jsonl, postgres, braintrust } from 'agent-otel/sinks';
import { withPrivacy, PrivacyProxy } from 'agent-otel/privacy';

const proxy = new PrivacyProxy();

const router = defineRouter({
  sinks: {
    // KEEP: Braintrust as your eval/playground/experiments backend.
    // ADD: PII masking so customer emails / tokens never reach Braintrust.
    braintrust: withPrivacy(
      braintrust({ apiKey: process.env.BRAINTRUST_API_KEY!, project: 'support-agent' }),
      { proxy, redactKeys: ['auth.token'] },
    ),
    // ADD: vendor-neutral local archive — escape hatch + audit trail
    archive: postgres({ url: process.env.DATABASE_URL!, table: 'spans' }),
    // ADD: cheap on-disk dump for backfill / replay later
    jsonl:   jsonl({ path: './prod-traces.jsonl' }),
  },
  rules: [{ match: '*', to: ['braintrust', 'archive', 'jsonl'] }],
});
```

What this gets you that Braintrust alone doesn't:

| Need | Braintrust alone | + agent-otel |
|---|---|---|
| Eval / playground / experiments | ✓ | ✓ (unchanged) |
| Trace ingest + dashboards | ✓ | ✓ (unchanged) |
| **PII masking before vendor sees it** | ✗ | ✓ via `withPrivacy()` (e2e tested against live Braintrust API) |
| **Vendor-neutral archive** (Postgres / S3 / JSONL) | ✗ | ✓ |
| **Programmatic agent self-debug** (`scry` SDK + CLI) | ✗ | ✓ |
| **Counterfactual replay** ("what if Sonnet 4.7?") | manual playground only | `replayLLMCall()` — see below |
| **MCP server** for Claude Code / Cursor to query traces | ✗ | planned |
| **Lock-in escape** — leave whenever | hard | trivial; spans archived in your own store |

The pitch isn't *replace your vendor*. It's *keep what works, add what's missing*.

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

Take spans you already captured, re-route them through any router config. Concrete workflows this enables:

### Customer debugging without touching prod (the daily-driver use case)

A customer pings you: *"my agent broke yesterday at 3:14pm."*

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

Every step of that one trace pings you in Slack with attributes pretty-printed. Pure forensics, no prod impact, no re-execution. **This is the workflow you'll use weekly.**

### Vendor evaluation without a parallel-instrumentation week

You're on Phoenix; you want to evaluate Braintrust before switching. Without replay you'd instrument your agent to dual-write for a week, pay both, wait, decide. With replay: pipe last week's archived JSONL into Braintrust in 30 seconds. Decision before lunch.

### Backfill a sink you just added

Six months of archived traces; today you sign up for OpenPipe to fine-tune. Pipe the archive through an OpenPipe sink — six months of training data backfilled in one command, not from-now-forward only.

### Smoke-test a new routing rule

About to add `{ match: { 'llm.cost.total': '>0.5' }, to: ['cost-alerts'] }`. Will it spam? Replay last week through it with a memory sink. See the actual volume before deploying.

### Why this is unique

- Phoenix/Braintrust/etc. each own their data silo — you can't pipe Phoenix's stored traces into Braintrust without writing per-vendor ETL each time.
- OTel Collector is stateless and push-only; no concept of replay.
- Most tracing tools assume "live or never."

`agent-otel` separates the transport format (OTel) from the routing decisions (rules). You can re-decide destinations indefinitely.

## Counterfactual replay — re-run a stored LLM call with one thing swapped

`agent-otel/replay-execute` does what eval-platform playgrounds do, but **programmatically across many traces**. Take a stored LLM span, swap one thing (model, system prompt, temperature), call the real provider, get a real response. Not data-mutation — actual re-execution.

```ts
import { replayLLMCall, swapModel, swapSystem, pipe } from 'agent-otel/replay-execute';
import { postgres } from 'agent-otel/sinks';

const archive = postgres({ url: process.env.DATABASE_URL! });

// "Would my agent have made a different decision with Sonnet 4.7?"
const result = await replayLLMCall({
  source:   archive,
  spanId:   '0123abcd...',                       // a stored LLM span
  mutate:   swapModel('claude-sonnet-4-7'),
  provider: 'anthropic',
  apiKey:   process.env.ANTHROPIC_API_KEY!,
});

console.log('Original output:', result.originalSpan.attributes['llm.output_messages.0.message.content']);
console.log('New output:     ', result.newResponse.content);
console.log('Cost:           ', result.newResponse.tokens);
```

Composable mutators: `swapModel`, `swapSystem`, `setTemperature`, `appendMessage`, plus `pipe(...)` to chain them. Bring your own with `(req) => mutated`.

Works with any provider via the `execute` callback:

```ts
import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

await replayLLMCall({
  source: archive,
  spanId,
  mutate: swapModel('gpt-5'),
  execute: async (req) => {
    const resp = await openai.chat.completions.create(req as any);
    return { content: resp.choices[0].message.content ?? undefined, raw: resp };
  },
});
```

Built-in `provider: 'anthropic'` lazy-loads `@anthropic-ai/sdk` (optional peer dep). For OpenAI/Gemini/etc. supply your own `execute` until first-class adapters ship.

`dryRun: true` returns the mutated request without calling the provider — useful for "what does the request look like with my mutator applied" before paying for tokens.

**Concrete workflow this enables — replay → eval pipeline:**

1. Pull yesterday's failed traces from postgres (`scry query --status=ERROR --since=24h`)
2. For each, `replayLLMCall` with `swapModel('claude-sonnet-4-7')`
3. Pipe new responses into a Braintrust experiment for scoring
4. Decision: did upgrading the model fix more than it broke?

Their playground × N, scripted, repeatable. E2E tested against the real Anthropic API in `tests/e2e/replay-execute.test.ts`.

> **Note.** This is the **counterfactual single-LLM-call** flavor — re-runs ONE node of the trace. Re-executing the entire downstream subtree (so a tool's new response cascades) is a bigger feature on the roadmap; the single-call version covers the most common "what if I'd used the new model" workflow today.

## Sinks shipped today

| Sink | Module | What it does |
|---|---|---|
| Phoenix | `agent-otel/sinks/phoenix` | OTLP/HTTP to Phoenix. Self-hosted or cloud. Optional API key. |
| Braintrust | `agent-otel/sinks/braintrust` | OTLP/HTTP to Braintrust. Routes to a project's logs or an experiment. |
| Slack | `agent-otel/sinks/slack` | Posts spans as messages to a Slack incoming webhook. Built-in rate limiting. Pretty default formatter; bring your own. |
| Generic OTLP | `agent-otel/sinks/otlp` | Any OTLP/HTTP endpoint. Works with Honeycomb, Datadog, Tempo, Jaeger v2, LangSmith, Langfuse, anything that speaks OTLP. Defaults to protobuf via the official OTel exporter; JSON available as fallback. |
| S3 (and S3-compatible) | `agent-otel/sinks/s3` | Gzipped JSONL upload to S3 / R2 / MinIO / Backblaze. The cheap canonical archive sink. `@aws-sdk/client-s3` is an optional peer dep — install only if you use this sink. |
| Postgres | `agent-otel/sinks/postgres` | Insert spans into a Postgres table. Default OTel-canonical schema (or BYO via `columnMapper`). `ON CONFLICT (span_id) DO UPDATE` with JSONB attribute merge. Also the backing store `scry` queries. `postgres` is an optional peer dep — only required when using `url`. |
| In-memory | `agent-otel/sinks/memory` | JS array. Tests and replay. |
| JSONL file | `agent-otel/sinks/jsonl` | Append per span to a local file. Single-process. |

Planned: Sentry, OpenPipe, console pretty-printer, GCS native (vs S3-compat), generic webhook helper.

## Privacy: vendors see fakes, you keep the real

`agent-otel/privacy` wraps any sink so spans are PII-masked before consumption. Powered by [`pii-proxy`](https://github.com/mirkokiefer/pii-proxy) — replaces real PII with plausible fakes (not tokens, so LLM reasoning quality is preserved) via a bijective map. Real values stay in your canonical archive; vendors only ever see the fakes; round-tripping LLM responses still works because the map unmasks them back.

```ts
import { withPrivacy, PrivacyProxy } from 'agent-otel/privacy';

const proxy = new PrivacyProxy();  // shared across wrapped sinks → consistent fakes

const router = defineRouter({
  sinks: {
    archive:    jsonl({ path: './canonical.jsonl' }),       // RAW
    phoenix:    withPrivacy(phoenix({ ... }), { proxy }),    // MASKED
    braintrust: withPrivacy(braintrust({ ... }), { proxy }), // MASKED — same fakes as Phoenix
  },
  rules: [{ match: '*', to: ['archive', 'phoenix', 'braintrust'] }],
});
```

Output (real run, verified by e2e against the live Braintrust API in `tests/e2e/privacy-braintrust.test.ts`):

```
ARCHIVE     → "user.email": "mirko-test-abcd@kiefer.com", "auth.token": "sk-secret-..."
BRAINTRUST  → "user.email": "herman21@yahoo.com",       "auth.token": "[redacted]"
PHOENIX     → "user.email": "herman21@yahoo.com",       "auth.token": "[redacted]"  ← same fakes
```

Knobs:
- `redactKeys` — hard-redact specific attribute keys (auth tokens, secrets) instead of masking — replaced with literal `'[redacted]'`
- `passthroughKeys` — skip masking for non-PII keys that pii-proxy might over-detect (e.g., span markers you need to find your event later)
- `maskNames` — also mask span name + status_message (default: false)
- Map is JSON-serializable via `exportProxyMap` / `importProxyMap` for cross-process persistence

pii-proxy auto-detects: emails, phone numbers, IBAN/credit cards, IPs, named entities. Custom-format strings (tracking numbers, internal IDs) need either an explicit `redactKeys` entry or a custom detector — write one if your spans carry custom-shape PII.

This composition is uniquely ours. Phoenix/Braintrust/Datadog don't offer it. The OTel Collector has destructive redaction processors only — non-reversible. Reversible privacy + multi-vendor routing has not existed until now.

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

**v0.0.11 — pre-alpha.** Core router, eight reference sinks (memory/jsonl/otlp/phoenix/braintrust/slack/s3/postgres), replay (re-route flavor) + replay-execute (counterfactual single-LLM-call flavor), reversible PII masking via `agent-otel/privacy`, **auto-instrument for `@anthropic-ai/sdk`** via `agent-otel/anthropic`, `scry` CLI with query/trace/chain/stats subcommands (local-DB + remote-endpoint modes). 102 unit tests + e2e tests against real backends — including end-to-end verified `withPrivacy(braintrust())` (POST → fetch back, real values masked, fakes present), `replayLLMCall` against the real Anthropic API, and `instrument(Anthropic)` emitting OpenInference spans on real calls. API will change. Open issues, send PRs.

## Tests

```bash
bun test                  # unit tests (fast, no network)
bun run test:e2e          # end-to-end tests against real backends
                          # (skips per-test if env vars not set)
```

E2E tests verify each sink against a real backend. Required env vars and what's tested are documented in `tests/e2e/README.md`. CI without secrets passes (skip-if-missing pattern); local runs verify whatever you have keys for.

The package is independent — no required hosted account, no preferred backend. Use it with whatever stack.

## What's next

- **`scry mcp`** — same query primitives behind an MCP tool surface, so external agents (Claude Code, Cursor, etc.) can call `scry` without a shell. First MCP server in LLM-trace-land.
- **More auto-instrument adapters** — `agent-otel/openai`, `agent-otel/vercel-ai`, `agent-otel/mastra`. Anthropic shipped in v0.0.11. Streaming wrap for Anthropic in the same module.
- **Subtree re-execution** — extend `replayLLMCall` to re-run downstream tools/LLMs from the swap point, not just one node. Bridges to RL rollouts.
- **Healthcare/PHI detector preset** — `withPrivacy(sink, { preset: 'hipaa' })` bundling ICD-10 / NPI / MRN detectors on top of pii-proxy.
- **Annotation write-back** — agents record observations on past spans (their own labels for self-supervised eval data).

## License

MIT.
