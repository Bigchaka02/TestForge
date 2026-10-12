/**
 * Bytes a user may still upload: the limit minus the bytes used, never below 0.
 * Warns with console.warn when the user is over the limit.
 * Throws RangeError when the limit is negative.
 */
export function remainingQuota(used: number, limit: number): number {
  if (limit < 0) throw new RangeError('limit must not be negative');
  const left = limit - used;
  if (left < 0) console.warn(`over quota by ${-left} bytes`);
  return left > 0 ? left : 0;
}
