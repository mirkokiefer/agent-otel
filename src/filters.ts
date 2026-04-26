/**
 * Match a RoutedSpan against a MatchSpec.
 *
 * The grammar is intentionally tiny — strings, numbers, booleans, simple
 * comparisons, and presence. If you find yourself wanting more, you should
 * probably write a custom Sink that does its own filtering and route '*'
 * to it instead.
 */

import type { MatchSpec, MatchOp, RoutedSpan, AttrValue } from './types.js';

/** Fields on RoutedSpan that match-by-name keys can refer to directly. */
const TOP_LEVEL_FIELDS = new Set(['kind', 'status_code', 'name', 'span_kind']);

/** Walk a dotted attribute path: 'gen_ai.request.model' → attrs['gen_ai.request.model'] */
function readAttribute(span: RoutedSpan, key: string): AttrValue | undefined {
  // OTel uses flat dotted-string keys, not nested objects, so a direct lookup wins.
  return span.attributes[key];
}

function readField(span: RoutedSpan, key: string): string | undefined {
  switch (key) {
    case 'kind':
    case 'span_kind':
      return span.kind;
    case 'status_code':
      return span.status.code;
    case 'name':
      return span.name;
    default:
      return undefined;
  }
}

/**
 * Compare an attribute value against an expected expression.
 *
 * Expression grammar:
 *   '*'         — present (any non-undefined value)
 *   'exact'     — string equality, case-sensitive
 *   '>3.14'     — numeric: actual > 3.14
 *   '<3.14'     — numeric: actual < 3.14
 *   '>=3.14'    — numeric: actual >= 3.14
 *   '<=3.14'    — numeric: actual <= 3.14
 *   '!=foo'     — string inequality
 *   '==foo'     — explicit string equality (same as 'foo')
 *   number/bool — direct equality
 */
function compare(actual: AttrValue | undefined, expected: string | number | boolean): boolean {
  if (actual === undefined) return false;
  if (typeof expected === 'number')   return Number(actual) === expected;
  if (typeof expected === 'boolean')  return actual === expected;

  // string expected
  if (expected === '*') return true;

  if (expected.startsWith('>=')) return Number(actual) >= Number(expected.slice(2));
  if (expected.startsWith('<=')) return Number(actual) <= Number(expected.slice(2));
  if (expected.startsWith('!=')) return String(actual) !== expected.slice(2);
  if (expected.startsWith('==')) return String(actual) === expected.slice(2);
  if (expected.startsWith('>'))  return Number(actual) >  Number(expected.slice(1));
  if (expected.startsWith('<'))  return Number(actual) <  Number(expected.slice(1));

  // Default: case-sensitive string equality
  return String(actual) === expected;
}

function matchObject(
  span: RoutedSpan,
  spec: Record<string, string | number | boolean>,
): boolean {
  for (const [key, expected] of Object.entries(spec)) {
    if (TOP_LEVEL_FIELDS.has(key)) {
      const actual = readField(span, key);
      // '*' on a top-level field means "any value"
      if (typeof expected === 'string' && expected === '*') {
        if (actual === undefined) return false;
        continue;
      }
      if (typeof expected === 'string') {
        if (!compare(actual, expected)) return false;
      } else if (actual !== String(expected)) {
        return false;
      }
    } else {
      const actual = readAttribute(span, key);
      if (!compare(actual, expected)) return false;
    }
  }
  return true;
}

function isMatchOp(spec: unknown): spec is MatchOp {
  return typeof spec === 'object' && spec !== null && 'op' in spec
      && typeof (spec as { op: unknown }).op === 'string';
}

function matchOp(span: RoutedSpan, op: MatchOp): boolean {
  switch (op.op) {
    case 'and':       return op.specs.every(s => matches(span, s));
    case 'or':        return op.specs.some( s => matches(span, s));
    case 'not':       return !matches(span, op.spec);
    case 'substring': {
      const actual = readAttrOrField(span, op.key);
      if (actual === undefined) return false;
      const a = op.ignoreCase ? String(actual).toLowerCase() : String(actual);
      const b = op.ignoreCase ? op.value.toLowerCase()        : op.value;
      return a.includes(b);
    }
    case 'regex': {
      const actual = readAttrOrField(span, op.key);
      if (actual === undefined) return false;
      return new RegExp(op.pattern, op.flags).test(String(actual));
    }
  }
}

function readAttrOrField(span: RoutedSpan, key: string): AttrValue | undefined {
  if (TOP_LEVEL_FIELDS.has(key)) return readField(span, key);
  return readAttribute(span, key);
}

/** True if `span` matches `spec`. Multiple keys in a flat spec are AND'd. */
export function matches(span: RoutedSpan, spec: MatchSpec): boolean {
  if (spec === '*') return true;
  if (isMatchOp(spec)) return matchOp(span, spec);

  if (Array.isArray(spec)) {
    // Array form is OR — any sub-spec matches
    return spec.some(s => {
      if (s === '*') return true;
      if (isMatchOp(s)) return matchOp(span, s);
      return matchObject(span, s);
    });
  }

  return matchObject(span, spec);
}

// ---------------------------------------------------------------------------
// Combinator constructors
// ---------------------------------------------------------------------------

/** AND — span matches every sub-spec. */
export function and(...specs: MatchSpec[]): MatchOp {
  return { op: 'and', specs };
}

/** OR — span matches any sub-spec. */
export function or(...specs: MatchSpec[]): MatchOp {
  return { op: 'or', specs };
}

/** NOT — span does not match `spec`. */
export function not(spec: MatchSpec): MatchOp {
  return { op: 'not', spec };
}

/** Substring containment on an attribute or top-level field value. */
export function substring(key: string, value: string, ignoreCase = false): MatchOp {
  return { op: 'substring', key, value, ignoreCase };
}

/** Regex match on an attribute or top-level field value. */
export function regex(key: string, pattern: string | RegExp, flags?: string): MatchOp {
  if (pattern instanceof RegExp) {
    return { op: 'regex', key, pattern: pattern.source, flags: flags ?? pattern.flags };
  }
  return { op: 'regex', key, pattern, flags };
}
