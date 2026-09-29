/** Spins forever when n is negative (fixture for timeout handling). */
export function countDown(n: number): number {
  let steps = 0;
  while (n !== 0) {
    n = n - 1;
    steps = steps + 1;
  }
  return steps;
}
