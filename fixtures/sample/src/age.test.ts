import { test, expect } from 'vitest';
import { isEligible } from './age.js';

test('age 17 is not eligible', () => {
  expect(isEligible(17)).toBe(false);
});

test('age 25 is eligible', () => {
  expect(isEligible(25)).toBe(true);
});
