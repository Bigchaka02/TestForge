// Minimal stand-in for @types/node: only the declarations this fixture uses.
// Real projects install the real @types/node.
declare module 'node:path' {
  export function basename(path: string, suffix?: string): string;
  export function extname(path: string): string;
}

// Node globals used by a test in test/integration/realistic.test.ts.
declare var process: { env: Record<string, string | undefined> };
declare var Buffer: { byteLength(text: string): number };
