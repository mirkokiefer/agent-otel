/**
 * E2E: phoenix sink → real Phoenix instance.
 *
 * Required env:
 *   PHOENIX_OTEL_ENDPOINT     base URL (e.g. http://localhost:6006 or http://traces.claw1)
 *   PHOENIX_API_KEY           optional, sent as `api_key` header
 *
 * What we verify:
 *   - The phoenix sink posts a real span
 *   - Phoenix's GraphQL API can find it within a few seconds
 *   - The attributes we set landed correctly
 */

import { test, expect } from 'bun:test';
import { phoenix } from '../../src/sinks/phoenix.js';
import { skipIfMissing, makeTestSpan, randomHex } from './_helpers.js';

const endpoint = skipIfMissing('PHOENIX_OTEL_ENDPOINT');
const apiKey   = process.env.PHOENIX_API_KEY;

const PHOENIX_GQL_TIMEOUT_MS = 30_000;

async function gql(query: string, variables?: Record<string, unknown>) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['api_key'] = apiKey;
  const res = await fetch(`${endpoint}/graphql`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Phoenix gql ${res.status}: ${await res.text()}`);
  const body = await res.json() as { data?: any; errors?: any[] };
  if (body.errors) throw new Error(`Phoenix gql errors: ${JSON.stringify(body.errors)}`);
  return body.data;
}

test('phoenix sink — span lands and is queryable', async () => {
  if (!endpoint) return;

  // Unique span name lets us filter exactly without false positives across runs.
  // Phoenix's filter grammar: `name == '...'` is the most reliable shape.
  const marker = randomHex(8);
  const uniqueName = `agent-otel-e2e-${marker}`;
  const span = makeTestSpan({
    name: uniqueName,
    attributes: { 'agent_otel.marker': marker },
  });

  const sink = phoenix({ endpoint: endpoint!, apiKey });
  await sink.consume(span);
  await sink.flush?.();
  await sink.shutdown?.();

  // Get the default project id once
  const projectsData = await gql(`{ projects(first: 1) { edges { node { id } } } }`);
  const projectId = projectsData.projects.edges[0]?.node?.id;
  expect(projectId).toBeTruthy();

  // Phoenix ingest is async — poll until the span shows up (or timeout)
  let found: any = null;
  const deadline = Date.now() + PHOENIX_GQL_TIMEOUT_MS;
  while (Date.now() < deadline && !found) {
    const sd = await gql(`
      query($id: ID!, $cond: String!) {
        node(id: $id) {
          ... on Project {
            spans(first: 1, filterCondition: $cond) {
              edges { node { name attributes } }
            }
          }
        }
      }
    `, {
      id: projectId,
      cond: `name == '${uniqueName}'`,
    });

    const edge = sd.node.spans.edges[0];
    if (edge) found = edge.node;
    else await new Promise(r => setTimeout(r, 1000));
  }

  expect(found).toBeTruthy();
  expect(found.name).toBe(uniqueName);
  // Verify our attributes survived the round-trip via the proto serializer
  const attrs = JSON.parse(found.attributes);
  expect(JSON.stringify(attrs)).toContain(marker);
  expect(JSON.stringify(attrs)).toContain('anthropic');
}, PHOENIX_GQL_TIMEOUT_MS + 10_000);
