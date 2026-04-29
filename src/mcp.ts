/**
 * `scry mcp` — MCP server for trace inspection.
 *
 * Exposes the Inspectable surface as an MCP tool set so any MCP-aware
 * agent (Claude Code, Cursor, Devin, your own agents) can query, walk,
 * and reason about your stored traces — without a shell, without
 * bespoke glue.
 *
 * Tools registered:
 *   - scry_query_jobs    — list AGENT (job) spans matching a filter
 *   - scry_get_trace     — full trace as an ASCII tree by trace_id
 *   - scry_causal_chain  — walk root → target span path inside a trace
 *   - scry_stats         — aggregate stats over a filter
 *
 * Transport: stdio. The canonical local-dev MCP pattern — MCP client
 * spawns `scry mcp` as a subprocess. Streamable HTTP transport for
 * org-internal multi-user setups will land in a follow-up.
 *
 * Two backends (delegated to the existing CLI helpers):
 *   - --db <postgres-url>             — direct Postgres via the postgres sink
 *   - --endpoint <url> --token <jwt>  — remote scry HTTP endpoint
 *
 * Example MCP client config (Claude Code's .mcp.json):
 *
 *   {
 *     "mcpServers": {
 *       "scry": {
 *         "command": "npx",
 *         "args": ["scry", "mcp", "--db", "postgres://localhost/mydb"]
 *       }
 *     }
 *   }
 *
 * Auth: stdio mode trusts the local environment (the user runs the
 * command with their own DB credentials). HTTP mode validates whatever
 * auth the underlying backend requires — for `--endpoint --token`,
 * the token is sent on every upstream call, so the MCP server is just
 * a thin proxy.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  buildTree,
  causalChain,
  renderTree,
} from './trace-tree.js';
import { and as andMatch } from './filters.js';
import type { Inspectable, MatchSpec, RoutedSpan } from './types.js';

// ---------------------------------------------------------------------------
// Helpers shared with the CLI
// ---------------------------------------------------------------------------

/** Compact summary of a job span for the LLM consumer. */
function summarizeJob(s: RoutedSpan): Record<string, unknown> {
  return {
    trace_id:    s.traceId,
    span_id:     s.spanId,
    name:        s.name,
    status:      s.status.code,
    started_at:  new Date(s.startTimeUnixNano / 1e6).toISOString(),
    duration_ms: s.durationMs,
    cost:        s.attributes['llm.cost.total']  ?? null,
    model:       s.attributes['llm.model_name']  ?? null,
    error:       s.status.message ?? null,
  };
}

/**
 * Compose a job-listing filter. `openinference.span.kind = AGENT` selects
 * top-level job spans; status/limit/free-form attribute filters AND in
 * on top.
 */
function buildJobFilter(input: {
  status?:        string;
  attribute_key?: string;
  attribute_op?:  string;
}): MatchSpec {
  const parts: MatchSpec[] = [{ 'openinference.span.kind': 'AGENT' }];
  if (input.status) parts.push({ status_code: input.status });
  if (input.attribute_key && input.attribute_op !== undefined) {
    parts.push({ [input.attribute_key]: input.attribute_op });
  }
  return parts.length === 1 ? parts[0]! : andMatch(...parts);
}

// ---------------------------------------------------------------------------
// Build the MCP server
// ---------------------------------------------------------------------------

export interface BuildMcpServerOptions {
  /** The Inspectable backing this MCP server. Required. */
  inspectable: Inspectable;
  /** Server identity reported to clients. Defaults to 'scry'. */
  name?:    string;
  version?: string;
}

/**
 * Construct an `McpServer` instance with the four scry tools registered.
 * Caller decides which transport to attach.
 */
export function buildScryMcpServer(opts: BuildMcpServerOptions): McpServer {
  const server = new McpServer({
    name:    opts.name    ?? 'scry',
    version: opts.version ?? '0.0.16',
  });

  const ins = opts.inspectable;

  server.registerTool(
    'scry_query_jobs',
    {
      title:       'Query recent agent jobs',
      description:
        'List recent agent jobs (AGENT spans) matching a filter. Each result has ' +
        'trace_id, span_id, status (OK/ERROR), duration, name, start_time, cost, model. ' +
        'Use trace_id with scry_get_trace to drill into a job. Filter by status to find failed jobs.',
      inputSchema: {
        status:        z.enum(['OK', 'ERROR', 'UNSET']).optional()
                        .describe('Optional filter: only return jobs with this status'),
        limit:         z.number().int().min(1).max(100).optional()
                        .describe('Max jobs to return (default 20)'),
        attribute_key: z.string().optional()
                        .describe('Optional attribute key to filter on (e.g. "daslab.agent.id")'),
        attribute_op:  z.string().optional()
                        .describe('Match expression: exact value, ">N", "<N", "!=v", "==v", or "*" for presence'),
      },
    },
    async (input) => {
      const filter = buildJobFilter(input);
      const limit = Math.min(input.limit ?? 20, 100);
      const rows = await ins.findSpans(filter, { limit, order: 'recent' });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(rows.map(summarizeJob), null, 2),
        }],
      };
    },
  );

  server.registerTool(
    'scry_get_trace',
    {
      title:       'Get full trace as an ASCII tree',
      description:
        'Fetch a trace by trace_id and render the full call graph as an ASCII tree. ' +
        'Shows every LLM call, tool invocation, and DB query that happened during the job, ' +
        'with durations and statuses. Use after scry_query_jobs to drill into a specific run.',
      inputSchema: {
        trace_id: z.string().describe('Trace ID from scry_query_jobs'),
        attrs:    z.array(z.string()).optional()
                   .describe("Attributes to inline in the tree (default: ['llm.cost.total', 'llm.model_name'])"),
      },
    },
    async ({ trace_id, attrs }) => {
      const spans = await ins.getTrace(trace_id);
      if (spans.length === 0) {
        return {
          content: [{ type: 'text', text: `(no spans for trace ${trace_id})` }],
          isError: true,
        };
      }
      const forest = buildTree(spans);
      const inlineAttrs = attrs ?? ['llm.cost.total', 'llm.model_name'];
      return {
        content: [{ type: 'text', text: renderTree(forest, { attrs: inlineAttrs }) }],
      };
    },
  );

  server.registerTool(
    'scry_causal_chain',
    {
      title:       'Walk causal chain from a span back to its trace root',
      description:
        'Walk the parent-span chain from a target span back to the trace root. ' +
        "Use to answer 'what led to this error?' — pass the error span_id and get " +
        'the chain of decisions that produced it.',
      inputSchema: {
        trace_id: z.string().describe('Trace ID containing the target span'),
        span_id:  z.string().describe('Target span ID to walk back from'),
      },
    },
    async ({ trace_id, span_id }) => {
      const spans = await ins.getTrace(trace_id);
      if (spans.length === 0) {
        return {
          content: [{ type: 'text', text: `(trace ${trace_id} not found)` }],
          isError: true,
        };
      }
      const forest = buildTree(spans);
      const chain = causalChain(forest, span_id);
      if (chain.length === 0) {
        return {
          content: [{ type: 'text', text: `(span ${span_id} not in trace)` }],
          isError: true,
        };
      }
      const summary = chain.map(s => ({
        span_id:     s.spanId,
        name:        s.name,
        kind:        s.kind,
        status:      s.status.code,
        duration_ms: s.durationMs,
        error:       s.status.message ?? null,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
      };
    },
  );

  server.registerTool(
    'scry_stats',
    {
      title:       'Aggregate stats over the trace store',
      description:
        'Compute aggregate stats (span count, trace count, error count, average duration, ' +
        'total cost, time range) over a filtered subset. Useful for "how much did my agent ' +
        'cost this week" / "what is my error rate" questions.',
      inputSchema: {
        status:        z.enum(['OK', 'ERROR', 'UNSET']).optional()
                        .describe('Optional filter: only count spans with this status'),
        attribute_key: z.string().optional()
                        .describe('Optional attribute key to filter on'),
        attribute_op:  z.string().optional()
                        .describe('Match expression for the attribute'),
      },
    },
    async (input) => {
      const filter = (input.status || input.attribute_key)
        ? buildJobFilter(input)
        : undefined;
      const stats = await ins.stats(filter);
      return {
        content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }],
      };
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

/** Run the server on stdio — the canonical local-dev MCP transport. */
export async function runStdioServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stay alive until parent closes stdin (stdio transport handles lifecycle).
}
