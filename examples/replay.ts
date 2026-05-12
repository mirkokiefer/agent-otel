/**
 * Replay example: re-route an archived JSONL of spans through a fresh
 * router config. Demonstrates the "A/B compare destinations" workflow.
 *
 * Run:
 *   bun run examples/basic.ts            # produces /tmp/agent-otel-demo.jsonl
 *   bun run examples/replay.ts           # re-routes those spans through new sinks
 */

import { defineRouter } from '../src/index.js';
import { memory, jsonl } from '../src/sinks/index.js';
import { replay, fromJsonl } from '../src/replay.js';

const all = memory();
const errors = memory();

// Fresh router config for the replay — different rules from whatever
// originally produced the JSONL. This is the magic: storage is portable,
// routing is configurable, you can re-decide downstream destinations
// retroactively.
const router = defineRouter({
  sinks: {
    archive2: jsonl({ path: '/tmp/agent-otel-replay.jsonl' }),
    all,
    errors,
  },
  rules: [
    { match: '*',                       to: ['archive2', 'all'] },
    { match: { status_code: 'ERROR' },  to: ['errors']          },
  ],
});

const result = await replay({
  source: fromJsonl('/tmp/agent-otel-demo.jsonl'),
  router,
  // Tag every replayed span so downstream sinks can distinguish replays from live traffic
  transform: s => ({ ...s, attributes: { ...s.attributes, 'agent_otel.replay': true } }),
});

await router.shutdown();

console.log('replay summary :', result);
console.log('all received   :', all.spans.length, 'spans');
console.log('errors received:', errors.spans.length, 'spans');
console.log();
console.log('replay tagged the first span with replay=true ?', all.spans[0]?.attributes['agent_otel.replay']);
