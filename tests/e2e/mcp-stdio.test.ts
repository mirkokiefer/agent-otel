/**
 * E2E: spawn `scry mcp` as a real subprocess, talk MCP-over-stdio.
 *
 * This is the actual path MCP clients (Claude Code, Cursor, Devin) use:
 *   1. Spawn `scry mcp --db ...` as a child process
 *   2. Connect via stdio transport
 *   3. Initialize protocol handshake
 *   4. Call tools, verify responses
 *
 * No external services — uses an ephemeral SQLite-backed Postgres? No —
 * we use the in-memory backend by lazy-importing it. Wait — `scry mcp`
 * needs a real Inspectable, and the CLI's local mode wants `--db`
 * (Postgres) only.
 *
 * For this test we skip the spawn-and-talk-stdio path because it requires
 * a real DB. The unit test in src/mcp.test.ts already covers the
 * server's tool handling end-to-end with InMemoryTransport. What this
 * file covers: confirming the binary runs, the help text mentions mcp,
 * and an unconfigured `scry mcp` exits cleanly with a useful error.
 */

import { test, expect } from 'bun:test';

const BIN = `${import.meta.dir}/../../bin/scry`;

test('scry --help mentions the mcp subcommand', async () => {
  const proc = Bun.spawn([BIN, '--help'], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  expect(out).toContain('scry mcp');
  expect(out).toContain('Claude Code');
});

test('scry mcp without --db or --endpoint exits with config error', async () => {
  const proc = Bun.spawn([BIN, 'mcp'], { stdout: 'pipe', stderr: 'pipe' });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  expect(code).toBe(2);
  expect(stderr.toLowerCase()).toMatch(/no backend|configured|scry_db|scry_endpoint/);
});
