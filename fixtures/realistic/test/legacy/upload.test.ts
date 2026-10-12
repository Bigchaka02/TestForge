import { describe, expect, it } from 'vitest';

// Same file name as test/upload.test.ts, but it does not import src/upload.ts,
// so it is not a baseline test for uploadName.
describe('legacy upload sizes', () => {
  it.concurrent('formats kibibytes', () => {
    expect((2048 / 1024).toFixed(1)).toBe('2.0');
  });
});
