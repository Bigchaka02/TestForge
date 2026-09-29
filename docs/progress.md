# Progress and verification status

Last updated 2026-09-29. Environment: Linux x64, Node 22.22.2, npm 10.9.7.

## Commands run after the last change

| Command | Result |
|---|---|
| `npm run lint` | pass |
| `npm run typecheck` | pass |
| `npm run test:unit` | 112 passed (6 files) |
| `npm run test:integration` | 14 passed, real Vitest 5.0.2 + tsc 7.0.2 processes, about 40 s |
| `npm run package` | `testforge.vsix`, 14 files, 1.12 MB |
| `npm run package:check` | pass (no src/test/fixtures/node_modules/secrets; bundle needs only `vscode` + Node built-ins) |
| `npm run test:extension` | **blocked**: VS Code download host `update.code.visualstudio.com` returns 403 from this environment's egress policy. Tests compile; the command exits 1 |

## Acceptance criteria

| ID | Status | Evidence |
|---|---|---|
| A01 | Pipeline automated; editor command unverified | integration `isEligible` run; extension-host test written, blocked |
| A02 | Automated | `test/unit/analyze.test.ts` rejections; extension preflight runs before any model call or process |
| A03 | Code + unverified | `requireTrust` and consent at every pipeline entry in `src/extension.ts`; needs VS Code to test |
| A04 | Partly automated | invalid JSON / invalid-response / deadline in integration tests; LM error mapping in `src/providers/vscodeLm.ts` not exercised (needs a live model) |
| A05 | Automated | `test/unit/render.test.ts`, hostile titles executed for real in integration |
| A06 | Automated | baseline-failure and zero-test handling in runner/pipeline tests |
| A07 | Automated | `finalPrice` case kept as `failed`, status partial |
| A08 | Code | two-run signature comparison in `src/core/pipeline.ts`; not forced in a test |
| A09 | Automated | `test/unit/mutate.test.ts` |
| A10 | Automated | `isEligible`: existing 0/1, generated 1/1, shared denominator 1 |
| A11 | Automated | classify/score/compare tests |
| A12 | Automated | compare tests; no comparison without baseline (`clamp`) |
| A13 | Partly automated | cancellation during test validation reaps processes (integration); cancellation during model streaming not tested live |
| A14 | Code + unit | mutex in `src/extension.ts`; staleness in `src/storage/apply.ts` |
| A15 | Code | exclusive create, symlink refusal, idempotent re-apply in `applyGenerated`; no dedicated test yet |
| A16 | Automated | fixture source hashes unchanged after every integration run; no `.vite-temp` written |
| A17 | **Unverified** | VSIX builds and passes package check; installing in a clean VS Code profile needs a machine with VS Code |
| A18 | Unverified | README steps not run from a fresh clone |
| A19 | **Manual, not done** | keyboard/theme/CodeLens checks need VS Code |
| A20 | Documented | `docs/privacy.md` matches code as reviewed |

## Known limitations and placeholders

- Improvement pass (Stage 9) is a placeholder; runs use at most 2 model requests.
- `testforge.requirementsFile` setting is a placeholder.
- A synchronous infinite loop blocks Vitest's per-test timeout; the 15 s process deadline stops it, and those cases show `not-run`.
- If the extension host crashes mid-run, a hung test process may be left running (no OS-level watchdog).
- Only Linux x64 was tested. The Windows kill path (`taskkill`) is written but untested; macOS temp-path handling is fixed but untested.
- Live model smoke test not performed (no VS Code or model in this environment).
