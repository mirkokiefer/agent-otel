/**
 * `scry` CLI — peer into your agent's traces.
 *
 *   scry query --status=ERROR --since=10m
 *   scry trace get <trace_id>
 *   scry trace tree <trace_id>
 *   scry chain <trace_id> <span_id>
 *   scry stats [--since=1h]
 *   scry mcp        (Slice 3 — not implemented yet)
 *
 * Modes:
 *   - Local DB: SCRY_DB or --db=<postgres-url> connects directly to Postgres
 *     via the postgres sink's Inspectable surface. For super-admins / dev.
 *   - Remote: SCRY_ENDPOINT + SCRY_TOKEN talks to a Daslab-hosted scry HTTP
 *     endpoint that applies auth-scoping. (Slice 2 — not implemented yet.)
 *
 * Output:
 *   --output=json     pipe-friendly (default for non-tty stdout)
 *   --output=table    aligned columns (default for tty stdout, simple shapes)
 *   --output=tree     ASCII tree (used by `trace tree`; default for that cmd)
 */

import {
  buildTree,
  causalChain,
  renderTree,
  type TraceForest,
} from './trace-tree.js';
import { postgres as postgresSink } from './sinks/postgres.js';
import { and as andMatch } from './filters.js';
import type { Inspectable, MatchSpec, RoutedSpan } from './types.js';

// ---------------------------------------------------------------------------
// Arg parsing — small, predictable, no external dep.
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        // Look-ahead: if the next arg isn't a flag, treat as value
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else if (a.startsWith('-')) {
      // Short flags treated as boolean
      flags[a.slice(1)] = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// ---------------------------------------------------------------------------
// Time parsing — supports ISO and relative durations
// ---------------------------------------------------------------------------

/**
 * Parse a "since" string into an ISO datetime string. Accepts:
 *   - "5m", "1h", "2d"  → relative duration before now
 *   - ISO 8601 datetime
 */
export function parseSince(s: string): string {
  const rel = /^(\d+)\s*([smhd])$/.exec(s.trim());
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const ms = n * (unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000);
    return new Date(Date.now() - ms).toISOString();
  }
  // Treat as ISO; let `new Date` validate
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`unparseable --since: "${s}" (use 5m, 1h, 2d, or ISO)`);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Filter construction from CLI flags
// ---------------------------------------------------------------------------

const FILTER_FLAGS = new Set(['status', 'name', 'kind', 'trace', 'span', 'attr']);

export function buildFilter(flags: Record<string, string | true>): MatchSpec {
  const specs: MatchSpec[] = [];

  if (typeof flags.status === 'string') specs.push({ status_code: flags.status });
  if (typeof flags.kind   === 'string') specs.push({ kind:        flags.kind   });
  if (typeof flags.name   === 'string') specs.push({ name:        flags.name   });

  // --attr=key=value (repeatable via comma-separation)
  if (typeof flags.attr === 'string') {
    for (const piece of flags.attr.split(',')) {
      const eq = piece.indexOf('=');
      if (eq < 0) continue;
      const k = piece.slice(0, eq).trim();
      const v = piece.slice(eq + 1).trim();
      specs.push({ [k]: v });
    }
  }

  // --since=10m  → start_time >= isoString — handled at call site (sink doesn't
  // expose direct time filter via MatchSpec; we layer this on top of the query).
  // We still record it here as a marker so the dispatcher can apply it.

  if (specs.length === 0) return '*';
  if (specs.length === 1) return specs[0]!;
  return andMatch(...specs);
}

// ---------------------------------------------------------------------------
// Output formatters
// ---------------------------------------------------------------------------

export type Output = 'json' | 'table' | 'tree';

export function pickDefaultOutput(cmd: string, isTty: boolean): Output {
  if (cmd === 'tree') return 'tree';
  if (!isTty) return 'json';
  return 'table';
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function formatTable(rows: RoutedSpan[]): string {
  if (rows.length === 0) return '(no spans)';
  // Compact columns: time, kind, status, dur, name, span_id, trace_id
  const header = ['start', 'kind', 'status', 'dur', 'name', 'span_id', 'trace_id'];
  const data = rows.map(s => [
    new Date(s.startTimeUnixNano / 1e6).toISOString(),
    s.kind,
    s.status.code,
    `${s.durationMs.toFixed(0)}ms`,
    s.name,
    s.spanId,
    s.traceId,
  ]);

  const widths = header.map((h, i) =>
    Math.max(h.length, ...data.map(r => String(r[i]).length)),
  );
  const fmtRow = (r: string[]): string =>
    r.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  return [
    fmtRow(header),
    fmtRow(widths.map(w => '─'.repeat(w))),
    ...data.map(fmtRow),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Sink / connection setup
// ---------------------------------------------------------------------------

export interface CliConfig {
  db?: string;
  endpoint?: string;
  token?: string;
}

export function readConfig(flags: Record<string, string | true>): CliConfig {
  const flag = (k: string): string | undefined =>
    typeof flags[k] === 'string' ? (flags[k] as string) : undefined;
  return {
    db:       flag('db')       ?? process.env.SCRY_DB,
    endpoint: flag('endpoint') ?? process.env.SCRY_ENDPOINT,
    token:    flag('token')    ?? process.env.SCRY_TOKEN,
  };
}

async function makeInspectable(cfg: CliConfig): Promise<Inspectable> {
  if (cfg.db) {
    return postgresSink({ url: cfg.db });
  }
  if (cfg.endpoint) {
    throw new Error('remote-mode (SCRY_ENDPOINT) is not yet supported in this build — set SCRY_DB or --db');
  }
  throw new Error('no backend configured. Set SCRY_DB=<postgres-url> or pass --db=<url>.');
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

interface CmdContext {
  parsed: ParsedArgs;
  out: (s: string) => void;
  err: (s: string) => void;
  isTty: boolean;
}

async function cmdQuery(ins: Inspectable, ctx: CmdContext): Promise<number> {
  const filter = buildFilter(ctx.parsed.flags);
  const limit  = numFlag(ctx.parsed.flags, 'limit', 50);
  const sinceIso = typeof ctx.parsed.flags.since === 'string'
    ? parseSince(ctx.parsed.flags.since)
    : undefined;

  // sinceIso is layered as a where (applied non-bypassably). Caveat: only
  // works if the sink's compiler honors top-level start_time, which it doesn't
  // yet (start_time isn't in TOP_LEVEL_FIELDS). Workaround: query without
  // since, then filter client-side. Acceptable for Slice 1 — agents/users
  // will use limit + recency and a client-side cut.
  const rows = (await ins.findSpans(filter, { limit, order: 'recent' })) as RoutedSpan[];
  const filteredByTime = sinceIso
    ? rows.filter(r => new Date(r.startTimeUnixNano / 1e6).toISOString() >= sinceIso)
    : rows;

  const fmt = (ctx.parsed.flags.output as Output | undefined) ?? pickDefaultOutput('query', ctx.isTty);
  ctx.out(fmt === 'json' ? formatJson(filteredByTime) : formatTable(filteredByTime));
  return 0;
}

async function cmdTraceGet(ins: Inspectable, ctx: CmdContext): Promise<number> {
  const traceId = ctx.parsed.positional[2];
  if (!traceId) { ctx.err('usage: scry trace get <trace_id>'); return 2; }
  const spans = (await ins.getTrace(traceId)) as RoutedSpan[];
  const fmt = (ctx.parsed.flags.output as Output | undefined) ?? pickDefaultOutput('trace get', ctx.isTty);
  ctx.out(fmt === 'json' ? formatJson(spans) : formatTable(spans));
  return 0;
}

async function cmdTraceTree(ins: Inspectable, ctx: CmdContext): Promise<number> {
  const traceId = ctx.parsed.positional[2];
  if (!traceId) { ctx.err('usage: scry trace tree <trace_id>'); return 2; }
  const spans = (await ins.getTrace(traceId)) as RoutedSpan[];
  if (spans.length === 0) { ctx.err(`(no spans for trace ${traceId})`); return 1; }
  const forest = buildTree(spans);
  const fmt = (ctx.parsed.flags.output as Output | undefined) ?? 'tree';
  if (fmt === 'json') {
    ctx.out(formatJson(serializeForest(forest)));
  } else {
    const attrs = typeof ctx.parsed.flags.attrs === 'string'
      ? ctx.parsed.flags.attrs.split(',').map(s => s.trim()).filter(Boolean)
      : ['llm.cost.total', 'llm.model_name'];
    ctx.out(renderTree(forest, { attrs }));
  }
  return 0;
}

async function cmdChain(ins: Inspectable, ctx: CmdContext): Promise<number> {
  const traceId = ctx.parsed.positional[1];
  const spanId  = ctx.parsed.positional[2];
  if (!traceId || !spanId) { ctx.err('usage: scry chain <trace_id> <span_id>'); return 2; }
  const spans = (await ins.getTrace(traceId)) as RoutedSpan[];
  if (spans.length === 0) { ctx.err(`(no spans for trace ${traceId})`); return 1; }
  const forest = buildTree(spans);
  const chain = causalChain(forest, spanId);
  if (chain.length === 0) { ctx.err(`(span ${spanId} not found in trace)`); return 1; }
  const fmt = (ctx.parsed.flags.output as Output | undefined) ?? pickDefaultOutput('chain', ctx.isTty);
  ctx.out(fmt === 'json' ? formatJson(chain) : formatTable(chain));
  return 0;
}

async function cmdStats(ins: Inspectable, ctx: CmdContext): Promise<number> {
  const filter = buildFilter(ctx.parsed.flags);
  const stats = await ins.stats(filter === '*' ? undefined : filter);
  ctx.out(formatJson(stats));
  return 0;
}

function numFlag(flags: Record<string, string | true>, key: string, dflt: number): number {
  const v = flags[key];
  if (typeof v !== 'string') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function serializeForest(forest: TraceForest): unknown {
  // Strip cyclic parent refs for JSON output
  const node = (n: import('./trace-tree.js').TraceNode): unknown => ({
    span: n.span,
    children: n.children.map(node),
  });
  return { roots: forest.roots.map(node) };
}

// ---------------------------------------------------------------------------
// Top-level dispatcher
// ---------------------------------------------------------------------------

const HELP = `\
scry — peer into your agent's traces.

USAGE:
  scry query       [--status=X] [--kind=X] [--name=X] [--attr=k=v] [--since=10m] [--limit=N] [--output=json|table]
  scry trace get   <trace_id>                       [--output=json|table]
  scry trace tree  <trace_id> [--attrs=k1,k2]       [--output=tree|json]
  scry chain       <trace_id> <span_id>             [--output=json|table]
  scry stats       [--status=X] [--attr=k=v]
  scry mcp         (not yet implemented in this build)

CONNECTION:
  --db=<postgres-url>     direct DB (or set SCRY_DB)
  --endpoint=<url>        remote scry HTTP endpoint (or set SCRY_ENDPOINT)
  --token=<jwt>           bearer token for remote (or set SCRY_TOKEN)

EXAMPLES:
  scry query --status=ERROR --since=10m | jq '.[] | .span_id'
  scry trace tree 0123abcd...
  scry chain 0123abcd... ffeedd00...

The MCP server (\`scry mcp\`) and remote endpoint mode ship in a later slice.
`;

export interface RunOptions {
  argv: string[];
  out?: (s: string) => void;
  err?: (s: string) => void;
  isTty?: boolean;
  /** Override inspectable construction (for tests). */
  makeInspectable?: (cfg: CliConfig) => Promise<Inspectable>;
}

/**
 * Run the CLI. Returns the exit code (0 for success). Caller is responsible
 * for `process.exit()`.
 */
export async function run(opts: RunOptions): Promise<number> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const isTty = opts.isTty ?? Boolean(process.stdout.isTTY);

  const parsed = parseArgs(opts.argv);

  if (parsed.flags.help || parsed.flags.h || parsed.positional.length === 0) {
    out(HELP);
    return parsed.positional.length === 0 ? 1 : 0;
  }

  const cmd = parsed.positional[0]!;

  // `scry mcp` not yet implemented
  if (cmd === 'mcp') {
    err('`scry mcp` is not yet implemented (Slice 3). Use library or HTTP endpoint instead.');
    return 2;
  }

  const cfg = readConfig(parsed.flags);
  let ins: Inspectable;
  try {
    const make = opts.makeInspectable ?? makeInspectable;
    ins = await make(cfg);
  } catch (e) {
    err(`scry: ${(e as Error).message}`);
    return 2;
  }

  const ctx: CmdContext = { parsed, out, err, isTty };

  try {
    switch (cmd) {
      case 'query':  return await cmdQuery(ins, ctx);
      case 'stats':  return await cmdStats(ins, ctx);
      case 'chain':  return await cmdChain(ins, ctx);
      case 'trace': {
        const sub = parsed.positional[1];
        if (sub === 'get')  return await cmdTraceGet(ins, ctx);
        if (sub === 'tree') return await cmdTraceTree(ins, ctx);
        err(`scry: unknown subcommand: trace ${sub ?? ''}`);
        return 2;
      }
      default:
        err(`scry: unknown command: ${cmd}`);
        return 2;
    }
  } catch (e) {
    err(`scry: ${(e as Error).message}`);
    return 1;
  } finally {
    // Best-effort sink shutdown so DB connections close.
    const sink = ins as unknown as { shutdown?: () => Promise<void> };
    await sink.shutdown?.().catch(() => { /* ignore */ });
  }
}
