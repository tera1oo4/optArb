import { createReadStream, createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { CaptureSink, Clock, Logger, RawCapture, Venue } from '@optarb/core';
import { noopLogger } from '@optarb/core';

export interface RotatingJsonlCaptureOptions {
  dir: string;
  clock: Clock;
  /** Hours to keep captured files, including the current one. Default 168 (7 days). */
  retentionHours?: number;
  logger?: Logger;
}

interface VenueState {
  venue: Venue;
  hour: string;
  stream: WriteStream;
  path: string;
}

const DEFAULT_RETENTION_HOURS = 168;
const HOUR_MS = 60 * 60 * 1000;

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function formatHour(tsMs: number): string {
  const d = new Date(tsMs);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}-${pad2(d.getUTCHours())}`;
}

function parseHour(hour: string): number {
  const year = Number(hour.slice(0, 4));
  const month = Number(hour.slice(4, 6)) - 1;
  const day = Number(hour.slice(6, 8));
  const h = Number(hour.slice(9, 11));
  return Date.UTC(year, month, day, h);
}

/**
 * Capture sink that rotates files every UTC hour, compresses the previous hour with
 * gzip, and deletes files older than the configured retention window (ADR-0005).
 */
export class RotatingJsonlCaptureSink implements CaptureSink {
  private readonly states = new Map<Venue, VenueState>();
  private readonly pending = new Set<Promise<void>>();
  private readonly retentionHours: number;
  private readonly logger: Logger;
  private closed = false;

  constructor(private readonly options: RotatingJsonlCaptureOptions) {
    mkdirSync(options.dir, { recursive: true });
    this.retentionHours = options.retentionHours ?? DEFAULT_RETENTION_HOURS;
    this.logger = options.logger ?? noopLogger;
  }

  record(entry: RawCapture): void {
    if (this.closed) return;
    const hour = formatHour(entry.tsMs);
    const venue = entry.venue;
    let state = this.states.get(venue);
    if (!state || state.hour !== hour) {
      if (state) this.rotate(state, hour);
      const path = join(this.options.dir, `${venue}-${hour}.jsonl`);
      const stream = createWriteStream(path, { flags: 'a' });
      stream.on('error', (err) => {
        this.logger.error('capture write error', { venue, hour, err: String(err) });
      });
      state = { venue, hour, stream, path };
      this.states.set(venue, state);
    }
    state.stream.write(`${JSON.stringify(entry)}\n`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const closers: Promise<void>[] = [];
    for (const state of this.states.values()) {
      closers.push(
        new Promise<void>((resolve) => {
          state.stream.end(() => resolve());
        }),
      );
    }
    await Promise.all(closers);
    this.states.clear();
    await Promise.all([...this.pending]);
    await this.cleanup();
  }

  private rotate(old: VenueState, newHour: string): void {
    this.states.delete(old.venue);
    const done = new Promise<void>((resolve, reject) => {
      old.stream.end(() => {
        this.compressAndCleanup(old.path)
          .then(() => resolve())
          .catch((err) => {
            this.logger.error('capture compression failed', { path: old.path, err: String(err) });
            reject(err);
          });
      });
    });
    this.pending.add(done);
    done.finally(() => this.pending.delete(done));
  }

  private async compressAndCleanup(path: string): Promise<void> {
    await compressFile(path);
    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    const cutoffMs = this.options.clock.nowMs() - this.retentionHours * HOUR_MS;
    const files = await readdir(this.options.dir).catch(() => []);
    const deletions: Promise<void>[] = [];

    for (const file of files) {
      const match = /^(.+)-(\d{8})-(\d{2})\.jsonl(\.gz)?$/.exec(file);
      if (!match) continue;
      const hour = `${match[2]}-${match[3]}`;
      const fileHourMs = parseHour(hour);
      if (fileHourMs < cutoffMs) {
        const fullPath = join(this.options.dir, file);
        deletions.push(
          rm(fullPath, { force: true }).catch((err) => {
            this.logger.error('capture retention deletion failed', {
              path: fullPath,
              err: String(err),
            });
          }),
        );
      }
    }

    await Promise.all(deletions);
  }
}

export async function compressFile(path: string): Promise<void> {
  const gzPath = `${path}.gz`;
  await pipeline(createReadStream(path), createGzip(), createWriteStream(gzPath));
  await rm(path, { force: true });
}

/** Test helper: create a raw capture file with a specific hour in its name. */
export async function writeHourFile(
  dir: string,
  venue: Venue,
  hour: string,
  content: string,
): Promise<void> {
  const path = join(dir, `${venue}-${hour}.jsonl`);
  await writeFile(path, content);
}

/** Test helper: check whether a file exists. */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
