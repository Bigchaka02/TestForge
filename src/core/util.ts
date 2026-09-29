import { createHash, randomBytes } from 'node:crypto';

export const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

export const newRunId = (): string => randomBytes(4).toString('hex');

/** JSON with sorted object keys, so equal values fingerprint equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Resolves when the signal aborts; used with Promise.race. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

/** Per-key mutex: one active run per workspace. */
export class KeyedMutex {
  private readonly held = new Set<string>();
  tryAcquire(key: string): (() => void) | undefined {
    if (this.held.has(key)) return undefined;
    this.held.add(key);
    return () => this.held.delete(key);
  }
  isHeld(key: string): boolean {
    return this.held.has(key);
  }
}
