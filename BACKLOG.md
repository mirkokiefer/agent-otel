# Backlog

What's on the workbench, roughly in priority order. Not promises — issues
are open for discussion, PRs welcome on anything below.

Last reviewed: 2026-04-28 against v0.0.15.

---

## Near-term (next 1–2 releases)

### `scry mcp` — MCP server
The same query primitives behind an MCP tool surface so external agents
(Claude Code, Cursor, Devin) can call `scry` without a shell. First MCP
server in LLM-trace-land. Tools: `query_spans`, `get_trace_tree`,
`causal_chain`, `replay_trace`, `compare_traces`, `stats`. Auth via the
same JWT as the remote CLI mode (`SCRY_TOKEN`).

### Streaming wrap for the instrument modules
`agent-otel/anthropic`, `/openai`, `/openrouter`, `/vercel-ai` all pass
streaming calls through unwrapped today. Need: wrap the returned
`Stream<...>`, accumulate tool/text deltas, emit progressive token
attributes, finalize the span on stream close. One module at a time.

### Subtree replay-execute
`replayLLMCall` re-runs ONE node today. Real "would my agent decide
differently downstream" needs to re-execute the subtree from the swap
point — every tool call below the swapped LLM call is replayed (or
re-invoked if a side-effect-free replay is requested). Bridges to RL
rollouts. Significant scope.

### `agent-otel/openai-responses`
OpenAI's new Responses API (`client.responses.create`) is shaped
differently from Chat Completions and is becoming the primary surface
for new builds. Sibling adapter to the chat-completions one, same
OpenInference output.

---

## Tier 2 — provider coverage + ergonomics

### More adapters
- `agent-otel/gemini` — direct Proxy on `@google/genai` (covered today via
  Vercel AI middleware, but a direct adapter is cleaner)
- `agent-otel/mastra` — middleware for the Mastra agent framework
- `agent-otel/crewai-py` — Python sister package would mirror this surface

### `scry watch` — tail mode
`kubectl logs -f` for agent failures. `scry watch --status=ERROR` streams
new ERROR spans live in the terminal. The right shape for on-call.

### `scry init` scaffold
`npx scry init my-agent` drops you into a working observable agent
template — router, sinks, tracing wired up. 60 seconds from npx to
"I can see my agent's calls live."

### HIPAA / PHI detector preset
`withPrivacy(sink, { preset: 'hipaa' })` bundles ICD-10 / NPI / MRN
detectors on top of `pii-proxy`'s defaults. For healthcare buyers with
explicit compliance requirements.

---

## Tier 3 — ideas / not-yet-decided

### Annotation write-back
Agents record observations on past spans (`router.annotate(spanId, attrs)`).
Self-supervised eval data falls out for free. Postgres + memory sinks
support; write-only sinks no-op.

### Auto-instrument for `@modelcontextprotocol/sdk`
MCP server tool calls aren't instrumented today — but they're a growing
surface for agent traces. Wrap the MCP client's `callTool` so MCP tool
spans land alongside LLM and provider tool spans.

### Trace diff CLI
`scry diff <trace_a> <trace_b>` — surface attribute / timing / cost
deltas between two trace runs. Pairs with `replayLLMCall` to answer
"what did my model swap actually change?"

### Demo medium
A 30-second Loom or asciinema of `scry trace tree` rendering a real
multi-LLM agent run. Single highest-leverage marketing artifact.
Doesn't exist yet.

### Hosted demo
A small CodeSandbox / `bun create agent-otel-demo` template with a
fake agent emitting traces. "Try it without installing" path.

### Trust signals
- Second public adopter beyond the original maintainer's own use
- HN / Twitter / Will Brown DM for the Verifiers angle
- A real `agent-otel.dev` or `scry.dev` landing page (not just README)

---

## Open questions

- **Brand name decision.** Today: `agent-otel` (package) + `scry` (CLI).
  Like `kubernetes` / `kubectl`. Consider full rename to `scry` once the
  brand has earned recognition (probably ~6 months of adoption away).
- **Stream wrap accumulation strategy.** Per-token span attributes
  (small, frequent) vs accumulated final attributes (large, single
  emit). Probably the latter for parity with non-streaming spans.
- **Subtree replay tool-side semantics.** Re-execute side-effecting
  tools in counterfactual replay? Almost always no — but for some
  read-only tools (HTTP GETs, DB reads) re-execution is fine. Needs
  per-tool opt-in flag at registration time.
- **Responses API streaming.** OpenAI's Responses API has a different
  streaming primitive (`streamText` semantics). Probably needs its own
  module rather than sharing with chat completions wrap.
