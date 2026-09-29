import { test, expect } from 'vitest';
import { finalPrice } from './discount.js';

test('non-member pays full price', () => {
  expect(finalPrice(200, false)).toBe(200);
});
