# Progress and verification status

Last updated 2026-10-12 (v0.2, PR #2). Local environment: Linux x64, Node 22.22.2, npm 10.9.7. CI: GitHub Actions on `ubuntu-latest`, `macos-latest` and `windows-latest` with Node 22.

## Commands run after the last change

| Command | Result |
|---|---|
| `npm run lint` | pass (local and CI) |
| `npm run typecheck` | pass (local and CI) |
| `npm run test:unit` | 222 passed (12 files) |
| `npm run test:integration` | 29 passed, 1 skipped locally (a Windows-only test that runs in CI). Real Vitest 5.0.2 + tsc 7.0.2 processes on `fixtures/sample` and `fixtures/realistic`, about 2 minutes |
| `npm run package` | `testforge.vsix`, 17 files, 1.13 MB. CI uploads it as the `testforge-vsix` artifact |
| `npm run package:check` | pass (no src/test/fixtures/node_modules/secrets; bundle needs only `vscode` + Node built-ins) |
| `npm run test:extension` | 12 smoke tests in a real VS Code, run in CI on Linux, macOS and Windows. Blocked in the build container only (the VS Code download host returns 403) |

## Acceptance criteria

| ID | Status | Evidence |
|---|---|---|
| A01 | Automated | integration `isEligible` run; extension-host demo run from the command and from a CodeLens-style call |
| A02 | Automated | `test/unit/analyze.test.ts` rejections; preflight runs before any model call or process |
| A03 | Partly automated | `requireTrust` and consent at every entry in `src/extension.ts`; the smoke suite uses the test-only consent bypass, so the dialogs themselves are checked by hand |
| A04 | Partly automated | invalid JSON / invalid-response / deadline in integration tests; LM error mapping in `src/providers/vscodeLm.ts` not exercised (needs a live model) |
| A05 | Automated | `test/unit/render.test.ts`, hostile titles executed for real in integration |
| A06 | Automated | baseline failure, hook failure, unhandled error and zero-test handling in runner/pipeline tests |
| A07 | Automated | `finalPrice` case kept as `failed`, status partial; the possible-bug warning is checked in the extension host |
| A08 | Automated | `sameResults` stability tests in `test/unit/apply.test.ts` |
| A09 | Automated | `test/unit/mutate.test.ts`, all eight families and sampling |
| A10 | Automated | `isEligible`: existing 1/3, generated 3/3, shared denominator 3 |
| A11 | Automated | classify/score/compare tests |
| A12 | Automated | compare tests; no comparison without baseline (`clamp`) |
| A13 | Partly automated | cancellation during test validation reaps processes (integration, all three OSes); cancellation during model streaming not tested live |
| A14 | Code + unit | mutex in `src/extension.ts` (commands and chat tools); staleness in `src/storage/apply.ts` |
| A15 | Automated | `applyGenerated` tests in `test/unit/apply.test.ts`: create once, never overwrite, symlink refusal, outside-workspace refusal |
| A16 | Automated | fixture source hashes and the fixture's `vitest`/`typescript` packages unchanged after every integration run and after the extension-host demo run |
| A17 | Partly automated | the VSIX is built and checked in CI; installing it in a clean VS Code profile is still a manual step |
| A18 | Unverified | README steps not run from a fresh clone |
| A19 | **Manual, not done** | keyboard/theme/CodeLens checks need a person in VS Code |
| A20 | Documented | `docs/privacy.md` matches the code as reviewed |

## Bugs CI found in v0.2

All four were Windows-only and are fixed with tests (D12):

1. 8.3 short temp paths (`C:\Users\RUNNER~1`) did not match Vitest's long paths, so results went missing.
2. CRLF sources left `\r` in prompt lines, so documented evidence could not be matched.
3. VS Code passes lower-case drive letters; the Vitest CLI and the tests' `vitest` import loaded as two copies ("failed to find the current suite").
4. Inside VS Code, cleanup's recursive delete went through the `node_modules` junction and deleted packages from the project's `node_modules`.

## Manual run in a real workbench (2026-10-14)

The 0.2.0 VSIX was installed into a clean profile of openvscode-server 1.105.1 (VS Code for the web) and driven through the UI: audit, demo run, preview, Copy Test Proof and the `finalPrice` possible bug all matched this document's numbers. Screenshots are in [media/](media/). Desktop VS Code, a live model and the chat tools were not part of it.

## Review findings (fixed 2026-10-14)

Two code reviews and the workbench run found 22 issues after the last release candidate; all are fixed with tests. The main ones: consent policy version 2 (consents given to 0.1 ask again), progress and log lines never contain `if` condition text, a deadline during the improvement pass keeps the verified first pass, a declined tool confirmation can no longer be reused, a file watcher refreshes editor insights and STALE state, tests skipped on the original never count as detecting, Node globals type-check when `@types/node` is installed, cleanup unlinks links at any depth before deleting, the score CodeLens refreshes after a run, and proof text cannot form links, mentions or hidden characters. The two new extension-host tests (file watcher, preview) run in CI only.

## Known limitations and placeholders

- `testforge.requirementsFile` setting is a placeholder.
- A synchronous infinite loop blocks Vitest's per-test timeout; the 15 s process deadline stops it, and those cases show `not-run`.
- If the extension host crashes mid-run, a hung test process may be left running (no OS-level watchdog).
- Not tested by a person yet: a live model run (Copilot), the chat tools in a real agent-mode session, and a clean-profile VSIX install. See [development.md](development.md#manual-live-model-smoke-test).
- Real pnpm, yarn and bun installs are untested; only their lockfiles are accepted.
