import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VirtualClock, type RawCapture } from '@optarb/core';
import {
  RotatingJsonlCaptureSink,
  compressFile,
  fileExists,
  writeHourFile,
} from './rotating-jsonl-capture.js';

const gunzipAsync = promisify(gunzip);

function makeEntry(tsMs: number, venue: 'deribit' | 'okx' = 'deribit'): RawCapture {
  return {
    tsMs,
    venue,
    channel: 'ws',
    direction: 'in',
    payload: { ts: tsMs },
  };
}

function hourFor(tsMs: number): string {
  const d = new Date(tsMs);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCHours()).padStart(2, '0')}`;
}

describe('RotatingJsonlCaptureSink', () => {
  let dir: string;
  let clock: VirtualClock;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'optarb-rotating-'));
    clock = new VirtualClock();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes entries to an hourly file', async () => {
    clock.set(Date.UTC(2026, 6, 31, 10, 30, 0));
    const sink = new RotatingJsonlCaptureSink({ dir, clock });
    sink.record(makeEntry(clock.nowMs()));
    await sink.close();

    const currentFile = join(dir, `deribit-${hourFor(clock.nowMs())}.jsonl`);
    expect(await fileExists(currentFile)).toBe(true);
  });

  it('rotates and compresses the previous hour file', async () => {
    clock.set(Date.UTC(2026, 6, 31, 10, 30, 0));
    const sink = new RotatingJsonlCaptureSink({ dir, clock });
    sink.record(makeEntry(clock.nowMs()));

    clock.advance(60 * 60 * 1000);
    sink.record(makeEntry(clock.nowMs()));
    await sink.close();

    const previousHour = hourFor(Date.UTC(2026, 6, 31, 10, 30, 0));
    const currentHour = hourFor(clock.nowMs());
    const oldFile = join(dir, `deribit-${previousHour}.jsonl`);
    const oldGz = `${oldFile}.gz`;
    const currentFile = join(dir, `deribit-${currentHour}.jsonl`);

    expect(await fileExists(oldFile)).toBe(false);
    expect(await fileExists(oldGz)).toBe(true);
    expect(await fileExists(currentFile)).toBe(true);

    const compressed = await gunzipAsync(await (await import('node:fs/promises')).readFile(oldGz));
    expect(compressed.toString()).toContain(`"ts":${Date.UTC(2026, 6, 31, 10, 30, 0)}`);
  });

  it('deletes files older than retention hours', async () => {
    clock.set(Date.UTC(2026, 6, 31, 10, 0, 0));
    await writeHourFile(dir, 'deribit', '20260731-06', '{"ts":1}\n');
    await writeHourFile(dir, 'deribit', '20260731-07', '{"ts":2}\n');
    await writeHourFile(dir, 'deribit', '20260731-08', '{"ts":3}\n');
    await writeHourFile(dir, 'okx', '20260731-07', '{"ts":4}\n');

    const sink = new RotatingJsonlCaptureSink({ dir, clock, retentionHours: 2 });
    sink.record(makeEntry(clock.nowMs()));
    await sink.close();

    expect(await fileExists(join(dir, 'deribit-20260731-06.jsonl'))).toBe(false);
    expect(await fileExists(join(dir, 'deribit-20260731-07.jsonl'))).toBe(false);
    expect(await fileExists(join(dir, 'deribit-20260731-08.jsonl'))).toBe(true);
    expect(await fileExists(join(dir, 'okx-20260731-07.jsonl'))).toBe(false);
    expect(await fileExists(join(dir, `deribit-${hourFor(clock.nowMs())}.jsonl`))).toBe(true);
  });

  it('deletes old compressed files as well', async () => {
    clock.set(Date.UTC(2026, 6, 31, 10, 0, 0));
    await writeHourFile(dir, 'deribit', '20260731-05', '{"ts":1}\n');
    await compressFile(join(dir, 'deribit-20260731-05.jsonl'));

    const sink = new RotatingJsonlCaptureSink({ dir, clock, retentionHours: 2 });
    sink.record(makeEntry(clock.nowMs()));
    await sink.close();

    expect(await fileExists(join(dir, 'deribit-20260731-05.jsonl.gz'))).toBe(false);
  });

  it('keeps separate streams per venue', async () => {
    clock.set(Date.UTC(2026, 6, 31, 12, 0, 0));
    const sink = new RotatingJsonlCaptureSink({ dir, clock });
    sink.record(makeEntry(clock.nowMs(), 'deribit'));
    sink.record(makeEntry(clock.nowMs(), 'okx'));
    await sink.close();

    const files = await readdir(dir);
    expect(files).toContain(`deribit-${hourFor(clock.nowMs())}.jsonl`);
    expect(files).toContain(`okx-${hourFor(clock.nowMs())}.jsonl`);
  });
});

describe('compressFile', () => {
  it('gzips a file and removes the original', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'optarb-compress-'));
    const path = join(tmp, 'test.jsonl');
    await (await import('node:fs/promises')).writeFile(path, 'hello\n');

    await compressFile(path);

    expect(await fileExists(path)).toBe(false);
    expect(await fileExists(`${path}.gz`)).toBe(true);
    const compressed = await gunzipAsync(
      await (await import('node:fs/promises')).readFile(`${path}.gz`),
    );
    expect(compressed.toString()).toBe('hello\n');

    await rm(tmp, { recursive: true, force: true });
  });
});
