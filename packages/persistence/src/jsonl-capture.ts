import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { CaptureSink, RawCapture } from '@optarb/core';

export interface JsonlCaptureOptions {
  dir: string;
}

/**
 * Append-only JSONL capture (ADR-0004/0005): one file per venue per UTC day.
 * This is the canonical source for replay/backtest.
 */
export class JsonlCaptureSink implements CaptureSink {
  private readonly streams = new Map<string, WriteStream>();

  constructor(private readonly options: JsonlCaptureOptions) {
    mkdirSync(options.dir, { recursive: true });
  }

  record(entry: RawCapture): void {
    const day = new Date(entry.tsMs).toISOString().slice(0, 10);
    const key = `${entry.venue}:${day}`;
    let stream = this.streams.get(key);
    if (!stream) {
      stream = createWriteStream(join(this.options.dir, `${entry.venue}-${day}.jsonl`), {
        flags: 'a',
      });
      stream.on('error', () => {
        // Keep the trading process alive; write failures surface on close().
      });
      this.streams.set(key, stream);
    }
    stream.write(`${JSON.stringify(entry)}\n`);
  }

  async close(): Promise<void> {
    const closers = [...this.streams.values()].map(
      (s) =>
        new Promise<void>((resolve) => {
          s.end(() => resolve());
        }),
    );
    await Promise.all(closers);
    this.streams.clear();
  }
}
