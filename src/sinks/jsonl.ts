/**
 * JSONL file sink — append each span as one line to a local file.
 *
 * Single-process append; not safe for concurrent writers. For multi-writer
 * setups use an OTLP collector or a managed sink.
 */

import { appendFile, open, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';

import type { RoutedSpan, Sink } from '../types.js';

export interface JsonlSinkOptions {
  /** Path to the JSONL file. Created if missing. */
  path: string;
  /** If true, buffer spans in memory and flush in batches. */
  batchSize?: number;
}

export function jsonl(opts: JsonlSinkOptions): Sink {
  const batchSize = opts.batchSize ?? 1;
  let pending: string[] = [];
  let handle: FileHandle | null = null;
  let opening: Promise<void> | null = null;

  async function openHandle() {
    if (opening) return opening;
    opening = (async () => {
      await mkdir(dirname(opts.path), { recursive: true });
      handle = await open(opts.path, 'a');
    })();
    return opening;
  }

  async function drain() {
    if (pending.length === 0) return;
    if (!handle) await openHandle();
    const chunk = pending.join('');
    pending = [];
    if (handle) await handle.write(chunk);
    else        await appendFile(opts.path, chunk); // fallback if open failed
  }

  return {
    name: 'jsonl',
    async consume(span: RoutedSpan) {
      pending.push(JSON.stringify(span) + '\n');
      if (pending.length >= batchSize) await drain();
    },
    async flush() { await drain(); },
    async shutdown() {
      await drain();
      if (handle) {
        await handle.close();
        handle = null;
      }
    },
  };
}
