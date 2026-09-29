import { MIN } from './limits.js';

/**
 * Clamp value into [MIN, max]. Throws RangeError when max is below MIN.
 */
export const clamp = (value: number, max: number): number => {
  if (max < MIN) {
    throw new RangeError('max must be >= 0');
  }
  if (value <= MIN) return MIN;
  if (value >= max) return max;
  return value;
};
