import { test, expect } from 'vitest';
import { parseScore } from './score.js';

test('parses a plain score', async () => {
  expect(await parseScore('42')).toBe(42);
});
