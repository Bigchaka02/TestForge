/**
 * Members get 10% off orders of 100 or more.
 * Requirement: an order of exactly 100 by a member costs 90.
 */
export function finalPrice(total: number, member: boolean): number {
  // Deliberate bug for the demo: should be total >= 100.
  if (member === true && total > 100) {
    return total * 0.9;
  }
  return total;
}
