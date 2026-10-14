# Support matrix

TestForge supports a defined set of inputs. Anything outside it stops with a precise reason (status `unsupported`, `setup` or `blocked`). TestForge does not guess. Checks live in `src/analysis/analyze.ts`.

## Project

| Supported | Not supported |
|---|---|
| One package per workspace folder. `"type"` is `"module"`, `"commonjs"` or absent | Other `"type"` values; workspaces (`"workspaces"` in package.json or `pnpm-workspace.yaml`) |
| A lockfile: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock` or `bun.lockb`. It is only hashed | No lockfile. Only npm's `node_modules` layout is tested |
| Local `vitest` 5.x and `typescript` 6.x or 7.x already installed in `node_modules` | Missing or other majors. TestForge never installs packages |
| Node.js ≥ 22.12.0 (from `testforge.nodePath` or `PATH`) | Older Node |
| Trusted workspace | Restricted Mode: saved reports only |

Tested versions are in [`toolchain.json`](../toolchain.json): Node 22.22.2, Vitest 5.0.2, TypeScript 7.0.2 in the target.

## Target function

| Supported | Not supported |
|---|---|
| `.ts` source file inside the workspace folder | `.d.ts`, `*.test.ts`, `*.spec.ts`, files reached through a symlink that leaves the folder |
| Named `export function f(...) {}`, sync or `async` | `export default`, classes, methods, generators |
| `export const f = (...) => ...` or `= function (...) {}` | `let`/`var` exports, type parameters |

For an `async` function, `returns` is the resolved value and `throws` means the promise rejects.

## Imports (whole closure, including the baseline tests' imports)

| Supported | Not supported |
|---|---|
| Relative static imports and re-exports with a `.js` (mapped to `.ts`) or `.ts` extension. These files are sent | Extensionless or directory specifiers |
| `node:` built-ins. Needs `@types/node` installed, otherwise a setup error | Unprefixed built-ins (the message suggests `node:x`) |
| Installed packages, including scoped names and subpaths. Only the existence of `node_modules/<name>/package.json` is checked; package code is never read or sent | Packages that are not installed, path aliases (`@/`, `~/`), `#imports`, absolute paths |
| | `require()`, `import x = require()`, dynamic `import()` |

Packages must ship types or have `@types` installed, or the copy's type check fails. The report lists every external import as "(not sent)".

## Baseline (existing) tests

The baseline suite is:

- `<name>.test.ts`, `<name>.spec.ts` and `<name>.testforge.*.test.ts` next to the module;
- `__tests__/<name>.test.ts` or `.spec.ts` in the module's folder;
- `<name>.test.ts` or `.spec.ts` anywhere under the top-level `test/` or `tests/` folder.

Files in `__tests__/`, `test/` and `tests/` count only when they import the module directly with a relative import. Symlinks, dot folders and `node_modules` are skipped. At most 5 files.

Allowed: `describe`, the four hooks (`beforeEach`, `afterEach`, `beforeAll`, `afterAll`), `vi`, `.skip`, `.todo`, `.each`, `.for` and computed titles. Skipped and todo tests stay in the results and never count as detecting a mutation.

If a baseline file uses an unsupported feature, the run stops. The file is never silently ignored. `checkTestFile` rejects:

- `.only` (also inside chains such as `test.skip.only`), `.concurrent`, `.skipIf`, `.runIf`, `.fails`, `.extend`
- `fit`, `xit`, `xtest`, `fdescribe`, `xdescribe`
- snapshot matchers (`toMatchSnapshot`, `toMatchInlineSnapshot`, `toThrowErrorMatching[Inline]Snapshot`, `toMatchFileSnapshot`)
- importing anything from `vitest` other than `test`, `it`, `describe`, `expect`, the four hooks and `vi` (also `import type` and re-exports). Test helper files that import `vitest` follow the same rules.

A hook failure or an unhandled error (Vitest exits non-zero with no failing test) makes the run an error. Tests that rely on Vitest `globals: true` or read data files next to them fail in the temporary copy.

No baseline tests is allowed for Generate & Verify, but then there is no before/after comparison. Audit needs at least one baseline file.

## JSON value contract (model output)

Arguments and expected return values must be plain JSON:

- `null`, booleans, finite numbers, strings (≤ 4,000 chars), arrays (≤ 100 items), plain objects
- nesting depth ≤ 8. No `__proto__`, `constructor` or `prototype` keys
- no `undefined`, `NaN`, `Infinity`, `Date`, `BigInt`, functions or class instances
- each case ≤ 8 KiB. Title ≤ 200 chars. ≤ 5 evidence refs per case. ≤ 12 cases per response (8 accepted per run, plus up to 4 from the improvement pass)

The response must be one JSON object (schema v1). It may be wrapped in one outer ```` ```json ```` fence and must be ≤ 128 KiB. Evidence excerpts must appear in the cited lines, with whitespace normalized.

## Platforms

| Platform | Status |
|---|---|
| Linux x64 | Tested in CI: unit, integration and extension-host tests in a real VS Code |
| macOS | Tested in CI, same suites |
| Windows | Tested in CI, same suites (CRLF checkouts, 8.3 temp paths, `junction` links, `taskkill`) |

A live model run (Copilot) and a clean-profile VSIX install are checked by hand, not in CI.

## Limits (`LIMITS` in `src/core/types.ts`)

| Limit | Value |
|---|---|
| Source files in import closure | 10 |
| Baseline test files | 5 |
| Bytes per file | 64 KiB |
| Total context bytes | 128 KiB |
| Cases accepted per run / per response | 8 / 12, plus 4 from the improvement pass |
| Model requests per run | 3: first request, one correction retry, one improvement request |
| Model deadline per request | 45 s |
| Model response size | 128 KiB |
| Mutations sampled | 8 default, 20 max (`testforge.mutationSample`), spread evenly over the function |
| Per-test timeout | 2 s |
| Per-process deadline (tsc, Vitest) | 15 s |
| Global run deadline | 180 s default, 600 s max (`testforge.globalDeadlineSeconds`) |
| Captured process output | 1 MiB |
| History | 10 runs / 7 days |
| JSON depth / array / string | 8 / 100 / 4,000 |
| Title length / case size | 200 chars / 8 KiB |
