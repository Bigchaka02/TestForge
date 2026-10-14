/**
 * Parses a score between 0 and 100 from text.
 * Rejects with RangeError when the score is outside 0..100, and with TypeError when the text is not a number.
 */
export async function parseScore(text: string): Promise<number> {
  const n = Number(text.trim());
  if (text.trim() === '' || Number.isNaN(n)) throw new TypeError('not a number');
  if (n < 0 || n > 100) throw new RangeError('score must be within 0..100');
  return n;
}
