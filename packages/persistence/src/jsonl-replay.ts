import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { RawCapture } from '@optarb/core';

/** Streams capture entries from a JSONL file in recorded order (ADR-0004 replay). */
export async function* readCapture(filePath: string): AsyncGenerator<RawCapture> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    yield JSON.parse(trimmed) as RawCapture;
  }
}
