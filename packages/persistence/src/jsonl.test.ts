import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RawCapture } from '@optarb/core';
import { JsonlCaptureSink } from './jsonl-capture.js';
import { readCapture } from './jsonl-replay.js';

describe('JSONL capture round-trip', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'optarb-capture-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes and reads entries in order', async () => {
    const sink = new JsonlCaptureSink({ dir });
    const entries: RawCapture[] = [
      {
        tsMs: 1_750_000_000_000,
        venue: 'deribit',
        channel: 'ws',
        direction: 'in',
        payload: { a: 1 },
      },
      {
        tsMs: 1_750_000_000_100,
        venue: 'deribit',
        channel: 'ws',
        direction: 'out',
        payload: { b: 2 },
      },
    ];
    for (const e of entries) sink.record(e);
    await sink.close();

    const day = new Date(entries[0]!.tsMs).toISOString().slice(0, 10);
    const read: RawCapture[] = [];
    for await (const e of readCapture(join(dir, `deribit-${day}.jsonl`))) read.push(e);

    expect(read).toEqual(entries);
  });

  it('skips blank lines when reading', async () => {
    const sink = new JsonlCaptureSink({ dir });
    sink.record({
      tsMs: 1_750_000_000_000,
      venue: 'deribit',
      channel: 'ws',
      direction: 'in',
      payload: null,
    });
    await sink.close();

    const day = new Date(1_750_000_000_000).toISOString().slice(0, 10);
    const read: RawCapture[] = [];
    for await (const e of readCapture(join(dir, `deribit-${day}.jsonl`))) read.push(e);
    expect(read).toHaveLength(1);
  });
});
