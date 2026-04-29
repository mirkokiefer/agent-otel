/**
 * Unit tests for the scry MCP server — uses an in-process pair of
 * MCP transports so we never spawn a subprocess.
 *
 * Verifies:
 *   - Server registers the four tools and lists them
 *   - scry_query_jobs filters by status, returns summarized jobs
 *   - scry_get_trace renders a real ASCII tree
 *   - scry_causal_chain walks root → target
 *   - scry_stats aggregates correctly
 *   - Error paths return isError: true (missing trace, missing span)
 */

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { memory } from './sinks/memory.js';
import { buildScryMcpServer } from './mcp.js';
import type { RoutedSpan } from './types.js';

let nano = 1_700_000_000_000_000_000;
function span(p: Partial<RoutedSpan>): RoutedSpan {
  const start = nano; nano += 1_000_000;
  return {
    traceId: 't1', spanId: 's',
    parentSpanId: undefined,
    name: 'demo', kind: 'INTERNAL',
    status: { code: 'OK' },
    startTimeUnixNano: start,
    endTimeUnixNano:   start + 1_000_000,
    durationMs: 1,
    attributes: {},
    events: [], links: [],
    resource: {}, scope: { name: 'test' },
    ...p,
  };
}

const sink = memory();
let client: Client;

beforeAll(async () => {
  // Fixture: 3 jobs (1 ERROR), each with a small subtree
  for (const jobName of ['job_a', 'job_b', 'job_c']) {
    const status: 'OK' | 'ERROR' = jobName === 'job_b' ? 'ERROR' : 'OK';
    sink.consume(span({
      traceId: jobName,
      spanId:  `${jobName}_root`,
      name:    `job ${jobName}`,
      attributes: {
        'openinference.span.kind': 'AGENT',
        'llm.cost.total':          jobName === 'job_a' ? 0.10 : jobName === 'job_b' ? 0.50 : 0.20,
        'llm.model_name':          'claude-sonnet-4-7',
      },
      status: { code: status, message: status === 'ERROR' ? 'rate limit' : undefined },
    }));
    sink.consume(span({
      traceId: jobName,
      spanId:  `${jobName}_llm`,
      parentSpanId: `${jobName}_root`,
      name:    'llm claude-sonnet-4-7',
      kind:    'CLIENT',
      attributes: { 'openinference.span.kind': 'LLM' },
    }));
  }

  // Spin up server + in-memory paired transports
  const server = buildScryMcpServer({ inspectable: sink });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  client = new Client({ name: 'scry-test', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
});

test('lists 4 scry tools', async () => {
  const result = await client.listTools();
  const names = result.tools.map(t => t.name).sort();
  expect(names).toEqual(['scry_causal_chain', 'scry_get_trace', 'scry_query_jobs', 'scry_stats']);
});

test('scry_query_jobs returns summarized jobs', async () => {
  const result = await client.callTool({ name: 'scry_query_jobs', arguments: {} });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  const jobs = JSON.parse(text) as Array<{ trace_id: string; status: string; cost: number; model: string }>;
  expect(jobs.length).toBe(3);
  expect(jobs.every(j => j.model === 'claude-sonnet-4-7')).toBe(true);
});

test('scry_query_jobs filters by status', async () => {
  const result = await client.callTool({ name: 'scry_query_jobs', arguments: { status: 'ERROR' } });
  const jobs = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  expect(jobs).toHaveLength(1);
  expect(jobs[0].trace_id).toBe('job_b');
  expect(jobs[0].status).toBe('ERROR');
});

test('scry_get_trace renders ASCII tree', async () => {
  const result = await client.callTool({ name: 'scry_get_trace', arguments: { trace_id: 'job_a' } });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  expect(text).toContain('job job_a');
  expect(text).toContain('llm claude-sonnet-4-7');
  expect(text).toContain('└─');
});

test('scry_get_trace: missing trace → isError', async () => {
  const result = await client.callTool({ name: 'scry_get_trace', arguments: { trace_id: 'nonexistent' } });
  expect(result.isError).toBe(true);
});

test('scry_causal_chain walks root → target', async () => {
  const result = await client.callTool({
    name: 'scry_causal_chain',
    arguments: { trace_id: 'job_a', span_id: 'job_a_llm' },
  });
  const chain = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  expect(chain.map((s: { span_id: string }) => s.span_id)).toEqual(['job_a_root', 'job_a_llm']);
});

test('scry_causal_chain: missing span → isError', async () => {
  const result = await client.callTool({
    name: 'scry_causal_chain',
    arguments: { trace_id: 'job_a', span_id: 'nope' },
  });
  expect(result.isError).toBe(true);
});

test('scry_stats aggregates over filter', async () => {
  const all = await client.callTool({ name: 'scry_stats', arguments: {} });
  const allStats = JSON.parse((all.content as Array<{ text: string }>)[0]!.text);
  expect(allStats.spanCount).toBe(6);     // 3 jobs × 2 spans each
  expect(allStats.errorCount).toBe(1);    // job_b ERROR root span

  const errOnly = await client.callTool({ name: 'scry_stats', arguments: { status: 'ERROR' } });
  const errStats = JSON.parse((errOnly.content as Array<{ text: string }>)[0]!.text);
  expect(errStats.spanCount).toBe(1);
  expect(errStats.errorCount).toBe(1);
});
