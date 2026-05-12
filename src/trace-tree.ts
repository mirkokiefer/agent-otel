/**
 * Trace tree primitives.
 *
 * A flat list of spans is what storage gives you; a tree is what agents
 * reason about. This module reconstructs parent→child edges via
 * `parent_span_id`, then exposes the typical walks (causal chain, descendants,
 * siblings) so callers don't reimplement them.
 *
 * Pure data — no async, no I/O. Combine with `Inspectable.getTrace()` to
 * fetch spans, then build a tree on the result.
 */

import { matches } from './filters.js';
import type { MatchSpec, RoutedSpan } from './types.js';

/** A node in the trace tree: one span + its descendants. */
export interface TraceNode {
  span: RoutedSpan;
  children: TraceNode[];
  parent?: TraceNode;
}

/** Result of `buildTree` — usually a single root. */
export interface TraceForest {
  /**
   * Root nodes (spans whose `parentSpanId` is missing or refers to a span
   * not in the input set). Most well-formed traces yield exactly one root;
   * partial fetches or orphaned spans can yield multiple.
   */
  roots: TraceNode[];
  /** Lookup by span id. */
  bySpanId: Map<string, TraceNode>;
}

/**
 * Build a forest of trace nodes from a flat list of spans.
 *
 * The input does NOT have to be a single trace — spans from multiple traces
 * yield multiple roots. Spans with a `parentSpanId` referencing a span not
 * in the input become orphan roots (caller likely fetched a partial trace).
 */
export function buildTree(spans: RoutedSpan[]): TraceForest {
  const bySpanId = new Map<string, TraceNode>();
  for (const s of spans) bySpanId.set(s.spanId, { span: s, children: [] });

  const roots: TraceNode[] = [];
  for (const node of bySpanId.values()) {
    const pid = node.span.parentSpanId;
    const parent = pid ? bySpanId.get(pid) : undefined;
    if (parent) {
      parent.children.push(node);
      node.parent = parent;
    } else {
      roots.push(node);
    }
  }

  // Sort children by start_time so tree walks are chronological by default.
  const sortChildren = (n: TraceNode): void => {
    n.children.sort((a, b) => a.span.startTimeUnixNano - b.span.startTimeUnixNano);
    for (const c of n.children) sortChildren(c);
  };
  for (const r of roots) sortChildren(r);

  return { roots, bySpanId };
}

/**
 * Walk root → target span. Returns the chain of spans (root first, target last).
 *
 * Use case: "given an error span, what's the path of decisions that led here?"
 * Returns an empty array if `targetSpanId` is not in the forest.
 */
export function causalChain(forest: TraceForest, targetSpanId: string): RoutedSpan[] {
  const target = forest.bySpanId.get(targetSpanId);
  if (!target) return [];

  const chain: RoutedSpan[] = [];
  let cursor: TraceNode | undefined = target;
  while (cursor) {
    chain.push(cursor.span);
    cursor = cursor.parent;
  }
  chain.reverse();   // root → target
  return chain;
}

/**
 * All descendants of `node`, optionally filtered. Iterative DFS so very
 * deep trees don't blow the call stack.
 */
export function descendants(node: TraceNode, filter?: MatchSpec): RoutedSpan[] {
  const out: RoutedSpan[] = [];
  const stack: TraceNode[] = [...node.children];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (!filter || matches(n.span, filter)) out.push(n.span);
    for (const c of n.children) stack.push(c);
  }
  return out;
}

/**
 * Siblings of `spanId` — children of its parent, excluding itself.
 * Returns empty array if the span has no parent in the forest.
 */
export function siblings(forest: TraceForest, spanId: string): RoutedSpan[] {
  const node = forest.bySpanId.get(spanId);
  if (!node?.parent) return [];
  return node.parent.children.filter(c => c.span.spanId !== spanId).map(c => c.span);
}

/**
 * Find the first span (by start time) whose status is ERROR. Convenience
 * for the common case of "what was the first thing that broke."
 */
export function firstError(forest: TraceForest): RoutedSpan | undefined {
  // bySpanId values are unsorted; collect ERROR spans then sort by start time.
  const errs: RoutedSpan[] = [];
  for (const node of forest.bySpanId.values()) {
    if (node.span.status.code === 'ERROR') errs.push(node.span);
  }
  errs.sort((a, b) => a.startTimeUnixNano - b.startTimeUnixNano);
  return errs[0];
}

/**
 * Render the tree as a human-readable ASCII outline. Useful for the `scry trace tree`
 * CLI subcommand and for terminal-friendly logs.
 *
 *   chat anthropic [LLM, OK, 1.2s]
 *   ├─ http POST anthropic.com/v1/messages [CLIENT, OK, 1.1s]
 *   └─ ...
 *
 * Pass `attrs: ['llm.cost.total', 'llm.model_name']` to inline specific
 * attributes per node.
 */
export function renderTree(forest: TraceForest, opts?: {
  attrs?: string[];
  maxDepth?: number;
}): string {
  const attrs = opts?.attrs ?? [];
  const maxDepth = opts?.maxDepth ?? Infinity;
  const lines: string[] = [];

  const renderNode = (node: TraceNode, prefix: string, isLast: boolean, depth: number): void => {
    const branch  = depth === 0 ? ''   : (isLast ? '└─ ' : '├─ ');
    const childPrefix = depth === 0 ? '' : (isLast ? '   ' : '│  ');
    const dur = `${node.span.durationMs.toFixed(0)}ms`;
    const status = node.span.status.code;
    const inlineAttrs = attrs
      .map(k => {
        const v = node.span.attributes[k];
        return v === undefined ? null : `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`;
      })
      .filter(Boolean)
      .join(' ');
    const line = `${prefix}${branch}${node.span.name} [${node.span.kind}, ${status}, ${dur}]${inlineAttrs ? ' ' + inlineAttrs : ''}`;
    lines.push(line);

    if (depth >= maxDepth) {
      if (node.children.length > 0) {
        lines.push(`${prefix}${childPrefix}… (${node.children.length} children, depth limit)`);
      }
      return;
    }

    node.children.forEach((c, i) => {
      renderNode(c, prefix + childPrefix, i === node.children.length - 1, depth + 1);
    });
  };

  forest.roots.forEach((r, i) => {
    if (i > 0) lines.push('');
    renderNode(r, '', true, 0);
  });

  return lines.join('\n');
}
