# Demo

All demos use `fixtures/sample`, one npm ESM project with pinned Vitest 5.0.2 and TypeScript 7.0.2. Run `npm run fixtures:install` first.

## Main demo: the age-18 boundary

`src/age.ts`:

```ts
/** Eligible when age is at least 18. */
export function isEligible(age: number): boolean {
  return age >= 18;
}
```

The existing tests in `src/age.test.ts` check 17 → false and 25 → true. They miss the boundary.

1. Open `fixtures/sample` in VS Code (F5 from this repo does this) and trust the workspace.
2. Open `src/age.ts`. A **TestForge: Generate & Verify Tests** CodeLens appears above `isEligible`.
3. Run either:
   - **TestForge: Run Demo (fake model, no AI)**. This uses a deterministic fake provider, and the report is labeled `DEMO`. Or:
   - the CodeLens with a live model (see [development.md](development.md#manual-live-model-smoke-test)).
4. Approve the consent dialog. Demo mode asks too, because it still executes code. Then watch the progress stages: preflight → baseline (2 runs) → generating → validating candidates → mutations.
5. Expected result in **TestForge Results**:
   - One accepted case: `age 18 is eligible (boundary)`, basis `documented`, with the doc comment as evidence.
   - One mutation: `>=` → `>` on line 3.
   - Test Results: `Existing tests: 0/1 detected`, `With generated tests: 1/1 detected`, `Shared comparison: 0/1 → 1/1 (+1)`. In Mutation Checks, `Line 3: >= → >` shows `existing: MISSED · with generated: DETECTED`.
   - These numbers come from real `tsc` and Vitest runs on temporary copies. No score is shown before execution finishes.
6. **Preview Generated Tests** opens the rendered file read-only.
7. **Apply Tests** creates `src/age.testforge.<runId>.test.ts`. It never overwrites a file. Applying the same run again does nothing.

Measured timing (fake provider, pipeline only, Node 22.22.2, Linux x64 cloud container, 2026-09-29):

| Fixture | Status | Time | Mutation result |
|---|---|---|---|
| `isEligible` | completed | 3.9 s | existing 0/1 → with generated 1/1 |
| `finalPrice` | partial (requirement conflict) | 2.9 s | not scored |
| `clamp` | completed | 3.8 s | 0/3 detected: two of the three are equivalent mutants (`<=`→`<` at MIN and `>=`→`>` at max return the same value) and `max < MIN`→`<=` needs a `max = 0` case |
| `joinWords` | completed | 1.4 s | N/A, no supported mutations |
| `countDown` | partial (timeout) | 15.3 s | not scored; stopped by the 15 s process deadline |

A live model adds its own response time on top.

## Other fixtures

| File | Function | What it demonstrates |
|---|---|---|
| `src/discount.ts` | `finalPrice` | **Requirement conflict.** The doc says an order of exactly 100 by a member costs 90, but the code uses `> 100`. The generated case fails against the original code. It is kept for review, mutation scoring is skipped (`partial`), and Apply needs **Apply Failing Candidate** |
| `src/slow.ts` | `countDown` | **Timeout.** A negative input loops forever. A synchronous loop blocks Vitest's worker, so the 2 s per-test timeout probably cannot fire, and the 15 s process deadline is expected to kill the run instead (not yet confirmed by a test). The run is reported as a timeout, scoring is skipped, and the status is `partial` |
| `src/clamp.ts` | `clamp` | **No baseline + throws.** There is no adjacent test, so no before/after comparison. Includes a `throws RangeError` case, and imports `./limits.js` (import closure of two files) |
| `src/strings.ts` | `joinWords` | **No mutations.** There are no relational, equality or boolean-return operators, so the result is "No supported mutation opportunities" and the score is N/A |

The fake provider has canned cases only for these five functions. Any other function gets zero cases.
