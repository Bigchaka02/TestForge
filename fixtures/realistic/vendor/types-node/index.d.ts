// Minimal stand-in for @types/node: only the declarations this fixture uses.
// Real projects install the real @types/node.
declare module 'node:path' {
  export function basename(path: string, suffix?: string): string;
  export function extname(path: string): string;
}
