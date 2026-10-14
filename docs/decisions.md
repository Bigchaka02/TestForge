# Decisions

Short records of the choices behind TestForge. Source: [plan.md](plan.md) §2–§3.

## D1 Stack

- **Decision:** TypeScript (strict), bundled with esbuild to one CommonJS file (`vscode` external). ESLint + typescript-eslint. Vitest for TestForge's own tests. `@vscode/vsce` packages the VSIX. Publisher `testforge-dev` (local only), MIT license.
- **Reason:** Standard, small toolchain for VS Code extensions.
- **Consequence:** Runtime dependencies (`typescript`, `zod`) are bundled into `dist/extension.js`, so the VSIX is built with `--no-dependencies`.

## D2 Parser: bundled `typescript@6.0.3`

- **Decision:** The extension bundles TypeScript 6.0.3 and uses its JS compiler API for analysis and mutation.
- **Reason:** TypeScript 7.x is the native (Go) compiler and ships no JS compiler API. 6.0.3 is the last release that has one.
- **Consequence:** Target projects may use TypeScript 6.x or 7.x. TestForge only ever runs the target's own `tsc` CLI. It never loads the target's compiler as a library.

## D3 Custom mutation engine

- **Decision:** A small AST mutation engine (`src/mutation/mutate.ts`) with eight operator families: relational boundary, literal boundary (an integer compared with a relational operator, ±1), strict equality, boolean return, arithmetic (`+` is skipped when either side is a string or template), logical (`&&`/`||`), negation removal and `if` condition (`true`/`false`).
- **Reason:** StrykerJS must be installed into the target project, which TestForge does not do. It also mutates whole projects and cannot cheaply be limited to one function.
- **Consequence:** Mutations are simple. They only land inside the selected function body, and nested functions are skipped. The sample is capped at 8 by default and 20 at most, and `sampleMutations` spreads it evenly over the function instead of taking the first ones.

## D4 Validation with zod plus a JSON walker

- **Decision:** Model output is checked against zod strict objects (schema v1). `checkJsonValue` then checks depth, size, non-finite numbers and prototype keys.
- **Reason:** zod already handles schema checks well (Rule 2: use existing tools). JSON limits are simple enough to write by hand.
- **Consequence:** If the whole response fails validation, TestForge sends one correction retry. Individual bad cases stay visible in the report as `rejected`.

## D5 Core is vscode-free

- **Decision:** `src/core`, `analysis`, `generation`, `execution`, `mutation`, `report`, `storage` and `providers` (except `vscodeLm.ts`) import nothing from `vscode`. So does `src/ui/summary.ts`.
- **Reason:** The whole pipeline, the report renderers and the chat-tool text can then run under Vitest with the fake provider and real Vitest/tsc processes.
- **Consequence:** Only `src/extension.ts`, `src/ui/results.ts`, `src/ui/insights.ts` and `src/providers/vscodeLm.ts` touch the VS Code API.

## D6 Deterministic rendering

- **Decision:** Test source comes from a fixed template. Values are embedded as `data("<JSON string literal>")`, which calls `JSON.parse` when the test runs. Titles are embedded with `JSON.stringify`. Comments are made single-line, have control characters removed, and have `*/` defused.
- **Reason:** Model text must never become code.
- **Consequence:** Generated tests call the function through `Reflect.apply` and use `toStrictEqual`/throw checks. They test runtime behavior, not argument types at compile time.

## D7 Improvement pass

- **Decision:** After the mutation checks, the surviving mutations go to the model in one extra request (at most 3 requests per run). Up to 4 new cases are validated like the first ones, then run twice on the original code. If they pass, they join the generated file, the survivors are re-checked and the scores recomputed; otherwise the run retries once with only the passing cases.
- **Reason:** Survivors are exactly where the tests are weak, and the same validation rules keep model output as data.
- **Consequence:** The report records `improvement: { survivorsBefore, proposed, added, killed }`. Improvement cases are marked `round: 'improvement'`. A provider or validation error there becomes a note, not a failed run.

## D8 Audit mode (no AI)

- **Decision:** `mode: 'audit'` runs preflight, the baseline suite twice and every sampled mutant against the existing tests only. No model, no generated file, `scores.baseline` only.
- **Reason:** "How good are my tests?" is useful without AI, and it is the cheapest demo of mutation checks.
- **Consequence:** Audits need at least one baseline test file. Demo and audit share one execution-only consent.

## D9 Chat tools for agent mode

- **Decision:** Two language model tools, `testforge_auditTests` and `testforge_generateAndVerify`, share the commands' run logic. VS Code's tool confirmation is the consent; `invoke()` runs only a call whose mode, file, function, model and file list match a confirmation.
- **Reason:** Coding agents write tests too. With the tools, an agent can check its own tests and act on the surviving mutations listed in the result.
- **Consequence:** Tools never apply tests and never show dialogs; unsaved files or a busy workspace make them fail fast with a message for the calling model.

## D10 Editor insights and the Markdown proof

- **Decision:** Results are also shown in the editor: a gutter marker per mutated line (all detected or some missed), a score CodeLens, and a warning diagnostic for each documented case that fails against the code ("possible bug"). **Copy Test Proof** renders the run as GitHub Markdown.
- **Reason:** Results are most useful where the code is, and in the pull request.
- **Consequence:** Report text is untrusted (it can come from a model), so hovers and the proof escape it and strip hidden and bidi characters. Insights hide while the results are stale; the proof says STALE.

## D11 Real projects: external imports, lockfiles, CommonJS, test locations

- **Decision:** `node:` built-ins and installed packages are allowed with an existence check only. Any of five lockfiles is accepted and only hashed. CommonJS packages are accepted. Baseline tests are also found in `__tests__/`, `test/` and `tests/`, but only when they import the module. Hooks, `vi`, `.skip`/`.todo` and `.each`/`.for` are allowed in baseline tests.
- **Reason:** Real projects import packages, use other package managers and keep tests in folders.
- **Consequence:** The model never sees package code. The copy's tsconfig gets `"types": ["node"]` only when a file imports a `node:` built-in, which then needs `@types/node`. Skipped and todo tests never detect a mutation. A hook failure or an unhandled error makes the run an error.

## D12 Windows paths and links

- **Decision:** Run directories, the Vitest/tsc CLI paths and the copy's `node_modules` junction target use `fs.realpathSync.native`. Cleanup unlinks each copy's `node_modules` link before the recursive delete.
- **Reason:** CI found that Windows temp paths can be 8.3 short names, that VS Code passes lower-case drive letters while Vite uses upper case (two copies of `vitest` load), and that inside VS Code a recursive delete went through the junction and deleted packages from the project's `node_modules`.
- **Consequence:** Unit, integration and extension-host tests run on Windows in CI and check that the project's packages survive a run.

## Cuts and substitutions (plan §2)

| Item | Decision | Reason | Consequence |
|---|---|---|---|
| Module layout | ~10 source files in 6 folders instead of 12 modules / 13 folders | Hackathon scope | Same responsibilities, fewer files |
| Suite A and suite B mutation runs | One Vitest run per mutation, with baseline and generated outcomes read from the same report | Halves runtime | Both scores use the same mutants |
| Improvement pass (Stage 9) | Built in v0.2 (D7) | | |
| Report history | Kept (10 runs / 7 days) in one list. The code uses `workspaceState` (per workspace), not the `globalState` named in the plan | Simple | See [privacy.md](privacy.md) |
| Stale temp-dir cleanup | Kept: on activation, owned dirs (sentinel file) older than 1 day are deleted | ~15 lines | Crash leftovers are removed |
| Secret detection | Best-effort regex. The run stops when it finds a match | As the spec says | Can miss secrets and can flag false positives |
| Process-tree kill | POSIX process groups. Windows uses `taskkill` (no shell) | Tested in CI on Windows | See [support-matrix.md](support-matrix.md) |
| Apply Failing Candidate | Kept as a separate command | Cheap | Needs explicit user action |
| Extension-host tests | Smoke suite in a real VS Code, run by GitHub Actions on Linux, macOS and Windows | The build environment cannot download VS Code | See [development.md](development.md) |
| Requirements document | **Placeholder** setting `testforge.requirementsFile`, not read by the code | Nice-to-have | Setting has no effect |
| Extra fixtures | Two fixture projects instead of 8+: `fixtures/sample` (ESM, the demo) and `fixtures/realistic` (CommonJS, `node:` and package imports, tests in `__tests__/` and `test/`) | Cover the classification paths that matter | See [demo.md](demo.md) |
| Flakiness check | Kept: the baseline and the candidate suite each run twice | One loop | Differing results stop scoring (`unstable`) |
| No push to a remote (spec) | Overridden: work is committed to a branch and a PR is opened | Project repo rules | Marketplace publishing stays out of scope |
