# TestForge — Revised Plan

Source: the pass-along spec in the kickoff message, critiqued and revised under Hadey's five rules. Where the spec and the rules conflict, the rules win. Every cut or substitution is listed in §2 with its reason.

## 1. Research findings (checked 2026-09-29 in this environment)

| Topic | Finding | Consequence |
|---|---|---|
| Node / npm | Node 22.22.2, npm 10.9.7 on Linux x64 | Development and fixtures pinned to this |
| Vitest | Latest 5.0.2. `node node_modules/vitest/vitest.mjs run --config <file> --reporter=json --outputFile=<file>` works and produces the Jest-style JSON (`testResults[].assertionResults[].status/failureMessages`) | Adapter parses this schema; tested version recorded in `toolchain.json` |
| TypeScript | Latest 7.0.2 is the native (Go) compiler: its package exposes only a CLI, no JS compiler API. 6.0.3 is the last release with the JS API | Extension bundles `typescript@6.0.3` as its parser. Target projects may use 6.x or 7.x; only their `tsc` CLI is invoked |
| VS Code API | `@types/vscode` latest is 1.138.0; pinned to 1.100.0 to match `engines.vscode ^1.100.0`. Language Model API (`vscode.lm.selectChatModels`, `sendRequest`, `countTokens`) is stable | Real provider uses it; no API keys |
| Packaging | `@vscode/vsce` 4.0.0, `esbuild` 0.28.2 | Bundle with esbuild, package with vsce |
| Extension-host tests | `@vscode/test-cli` 0.0.15 + `@vscode/test-electron` 3.1.0 need to download VS Code | Download host `update.code.visualstudio.com` is blocked by this environment's egress policy (403). Tests are written but this gate is recorded as **unverified** |
| Existing tools (Rule 2) | StrykerJS does mutation testing but needs installing into the target project and mutates whole projects; zod does schema validation; Vitest's JSON reporter does result reporting | Use zod and Vitest's reporter; keep the tiny 3-operator mutation engine (see D3) |
| Skills (Rule 1) | No skill for VS Code extensions is available; none needed | None used |

## 2. Critique of the pass-along spec

What it gets right: data-only model output with deterministic rendering, execution against copies, honest metrics (killed/(killed+survived), shared denominators, timeouts excluded), explicit Apply, trust and consent gates. These stay.

What is overengineered for a hackathon (Rule 4) and how it is revised:

| Spec item | Revision | Reason |
|---|---|---|
| 12 modules, 13 folders | ~10 source files in 6 folders | Same responsibilities, less ceremony |
| Separate suite A and suite B mutation runs | One Vitest run per mutation; A and B outcomes read from the same report by test file | Halves runtime, same data |
| Bounded improvement pass (Stage 9) | **Placeholder**: the `improving` stage records a limitation when mutations survive; no extra request is sent (so a run uses at most 2 of the 3 allowed requests) | Spec lists it first among cuts; keeps the pipeline honest |
| Report history retention (10 runs / 7 days) | Kept, as one `workspaceState` list | Simple |
| Stale temp-dir cleanup after restart | Kept: delete owned dirs (sentinel file) older than 1 day on activation | ~15 lines |
| Secret detection | Best-effort regex, stop with explanation | As spec says, best-effort |
| Cross-platform process-tree kill | POSIX process groups; Windows `taskkill` via `execFile` without shell, untested | Only Linux is advertised |
| "Apply Failing Candidate" separate command | Kept (one flag on apply) | Cheap |
| Extension-host test suite | A small smoke suite; gate unverified here (download blocked) | Environment limit |
| Requirements document selection | **Placeholder** setting `testforge.requirementsFile` | Nice-to-have |
| 8 extra fixtures | One fixture project `fixtures/sample` with 5 modules: age (demo), clamp (no baseline, throws), discount (buggy vs requirement), slow (hang), strings (no mutations) | Cover the classification paths that matter |
| Two runs of each suite for flakiness | Kept | One loop |

Conflicts with the rules or the project:

- The spec forbids pushing to a remote. The project repo supersedes that: work is committed to a branch and a PR is opened. Marketplace publishing stays out of scope.
- The spec's 48-hour schedule is dropped; verification gates stay.

## 3. Decisions

- **D1 Stack:** TypeScript strict, esbuild bundle (CJS, `vscode` external), ESLint + typescript-eslint, Vitest for our own unit/integration tests, vsce for the VSIX. Publisher `testforge-dev` (local). License MIT.
- **D2 Parser:** bundled `typescript@6.0.3` (see §1).
- **D3 Mutation engine:** custom, ~80 lines on the TS AST. Stryker would require installing into the user's project, which the spec forbids, and cannot scope to one function cheaply.
- **D4 Validation:** zod strict objects for the case schema plus a small JSON-value walker for depth/size/prototype keys.
- **D5 Core is vscode-free:** `src/core` and friends import nothing from `vscode`, so the pipeline runs under Vitest with a fake provider and real Vitest/tsc processes.
- **D6 Rendering:** values are embedded as `JSON.parse(<JSON.stringify(JSON.stringify(v))>)`; titles via `JSON.stringify`; comments strip newlines and `*/`.

## 4. Plan: steps and sub-steps

### Step 1 — Establish the project
1.1 Branch, `package.json` (engines.vscode `^1.100.0`, untrustedWorkspaces `limited`), `tsconfig`, ESLint, esbuild script.
1.2 `toolchain.json` with exact tested versions.
1.3 `.vscode/launch.json` for the extension host.

### Step 2 — Prove the toolchain
2.1 `fixtures/sample` npm ESM project with `isEligible`, two baseline tests, lockfile, Vitest 5.0.2, TypeScript 7.0.2.
2.2 Runner: spawn resolved Node with `shell:false`, bounded output, deadline, cancellation (process-group kill).
2.3 Execution workspace: temp dir with sentinel, copy files, symlink `node_modules`, write own Vitest config and tsconfig.
2.4 Integration test: baseline runs, JSON report parses, source hashes unchanged.

### Step 3 — Contracts and lifecycle
3.1 Types: `ModelCasePlan` (schema v1), `RunReport`, error categories as a discriminated union, stage names.
3.2 Limits object (spec §11 defaults).
3.3 Per-workspace mutex; deterministic IDs (sha256 of content).
3.4 Cleanup in `finally` for every exit.

### Step 4 — Analysis and context
4.1 Find eligible exports (named sync function / arrow, no generics, no async/generator).
4.2 Support checks: ESM `package.json`, lockfile, local vitest+typescript installed and version-checked, no non-relative runtime imports, no `require`/dynamic import.
4.3 Import closure (relative `.ts`, `.js`→`.ts`), symlink escape rejection, file/size limits, hashes.
4.4 Adjacent tests (`x.test.ts`, `x.spec.ts`, `x.testforge.*.test.ts`) with baseline restrictions (no `.only/.skip/.todo`, hooks, snapshots, `.each`).
4.5 Context text with file IDs and line numbers; secret-pattern stop; `.env`/keys excluded by construction (only closure files are read).

### Step 5 — Deterministic generation
5.1 Fake provider returning the age-18 case (and a labeled demo mode).
5.2 Validator: strict schema, export name, evidence excerpt must exist in the cited lines, limits, prototype keys, fence stripping.
5.3 Fingerprints, duplicate skip count, conflicting-expectation detection.
5.4 Renderer (D6) with `Reflect.apply`, deep equality, throws checks.

### Step 6 — Real AI adapter
6.1 `vscode.lm` model pick after user action; stored model ID.
6.2 Prompt with schema, context; token count vs `maxInputTokens`; stream with size cap and deadline; cancellation.
6.3 One correction retry on invalid JSON/schema; max 3 requests.
6.4 Error mapping (no models, consent denied, quota, cancelled). Manual smoke test documented.

### Step 7 — Mutation evaluation
7.1 Enumerate relational, strict-equality, boolean-return mutations inside the selected function body only (skip nested functions).
7.2 Deterministic IDs, sort, cap 8 (max 20).
7.3 Per mutation: write mutant to eval copy from pristine text, tsc, run Vitest, classify A and B separately.
7.4 Metrics with shared denominator; N/A for zero; no before/after without baseline.

### Step 8 — Improvement pass
8.1 Placeholder only (see §2).

### Step 9 — VS Code workflow
9.1 CodeLens "Generate & Verify Tests" above eligible exports; editor command with cursor target or picker.
9.2 Progress notification with cancel; output channel (no source logged).
9.3 TreeView with 5 groups (Run, Cases, Test Results, Mutation Checks, Limitations), text labels not color.
9.4 Preview generated file and mutation diffs via a read-only content provider.

### Step 10 — Apply and retention
10.1 Freshness check (hashes + dirty buffers); stale disables apply.
10.2 Exclusive create `module.testforge.<runId>.test.ts`; idempotent re-apply; path guards.
10.3 History (10 runs / 7 days), Clear History, discard, stale temp cleanup.

### Step 11 — Verification
11.1 Unit: validator, renderer, mutations, metrics, analysis.
11.2 Integration: full pipeline on fixtures with fake provider and real processes (A10 age-18 proof, buggy, hanging, no-baseline).
11.3 Extension-host smoke suite (written; unverified here).
11.4 `verify` script runs lint, typecheck, unit, integration, extension and fails loudly if any fails.

### Step 12 — Package and document
12.1 VSIX via vsce; inspect contents.
12.2 README, `docs/architecture.md`, `docs/decisions.md`, `docs/support-matrix.md`, `docs/privacy.md`, `docs/demo.md`, `docs/progress.md`.

### Step 13 — Report
13.1 Final status separating implemented, automatically tested, manually checked, blocked, unverified.

## 5. Acceptance mapping (A01–A20)

Tracked in `docs/progress.md` with the test or manual check that covers each.
