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

- **Decision:** A small AST mutation engine (`src/mutation/mutate.ts`) with three operator families: relational boundary, strict equality, and boolean return.
- **Reason:** StrykerJS must be installed into the target project, which TestForge does not do. It also mutates whole projects and cannot cheaply be limited to one function.
- **Consequence:** Mutations are few and simple. They only land inside the selected function body, and nested functions are skipped. The sample is capped at 8 by default and 20 at most.

## D4 Validation with zod plus a JSON walker

- **Decision:** Model output is checked against zod strict objects (schema v1). `checkJsonValue` then checks depth, size, non-finite numbers and prototype keys.
- **Reason:** zod already handles schema checks well (Rule 2: use existing tools). JSON limits are simple enough to write by hand.
- **Consequence:** If the whole response fails validation, TestForge sends one correction retry. Individual bad cases stay visible in the report as `rejected`.

## D5 Core is vscode-free

- **Decision:** `src/core`, `analysis`, `generation`, `execution`, `mutation` and `providers` import nothing from `vscode`.
- **Reason:** The whole pipeline can then run under Vitest with the fake provider and real Vitest/tsc processes.
- **Consequence:** Only `src/extension.ts` and `src/ui/*` touch the VS Code API, including the `vscode.lm` model provider.

## D6 Deterministic rendering

- **Decision:** Test source comes from a fixed template. Values are embedded as `data("<JSON string literal>")`, which calls `JSON.parse` when the test runs. Titles are embedded with `JSON.stringify`. Comments are made single-line, have control characters removed, and have `*/` defused.
- **Reason:** Model text must never become code.
- **Consequence:** Generated tests call the function through `Reflect.apply` and use `toStrictEqual`/throw checks. They test runtime behavior, not argument types at compile time.

## Cuts and substitutions (plan §2)

| Item | Decision | Reason | Consequence |
|---|---|---|---|
| Module layout | ~10 source files in 6 folders instead of 12 modules / 13 folders | Hackathon scope | Same responsibilities, fewer files |
| Suite A and suite B mutation runs | One Vitest run per mutation, with baseline and generated outcomes read from the same report | Halves runtime | Both scores use the same mutants |
| Improvement pass (Stage 9) | **Placeholder**: the stage only records a limitation when mutations survive | First cut listed in the spec | No follow-up model request is made |
| Report history | Kept (10 runs / 7 days) in one list. The code uses `workspaceState` (per workspace), not the `globalState` named in the plan | Simple | See [privacy.md](privacy.md) |
| Stale temp-dir cleanup | Kept: on activation, owned dirs (sentinel file) older than 1 day are deleted | ~15 lines | Crash leftovers are removed |
| Secret detection | Best-effort regex. The run stops when it finds a match | As the spec says | Can miss secrets and can flag false positives |
| Process-tree kill | POSIX process groups. Windows uses `taskkill` (no shell), which is **untested** | Only Linux is advertised | See [support-matrix.md](support-matrix.md) |
| Apply Failing Candidate | Kept as a separate command | Cheap | Needs explicit user action |
| Extension-host tests | Small smoke suite. **Unverified** in the build environment, because the VS Code download is blocked | Environment limit | `test:extension` must be run elsewhere |
| Requirements document | **Placeholder** setting `testforge.requirementsFile`, not read by the code | Nice-to-have | Setting has no effect |
| Extra fixtures | One fixture project (`fixtures/sample`) with five modules instead of 8+ projects | Cover the classification paths that matter | See [demo.md](demo.md) |
| Flakiness check | Kept: the baseline and the candidate suite each run twice | One loop | Differing results stop scoring (`unstable`) |
| No push to a remote (spec) | Overridden: work is committed to a branch and a PR is opened | Project repo rules | Marketplace publishing stays out of scope |
