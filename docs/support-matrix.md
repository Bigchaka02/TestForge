# Support matrix

The first release supports one narrow kind of input. Anything outside it stops with a precise reason (status `unsupported` or `blocked`). TestForge does not guess. Checks live in `src/analysis/analyze.ts`.

## Project

| Supported | Not supported |
|---|---|
| One npm package per workspace folder with `"type": "module"` | CommonJS packages, npm workspaces / monorepos |
| `package-lock.json` present | Yarn/pnpm-only projects (no npm lockfile) |
| Local `vitest` 5.x and `typescript` 6.x or 7.x already installed in `node_modules` | Missing or other majors. TestForge never installs packages |
| Node.js ≥ 22.12.0 (from `testforge.nodePath` or `PATH`) | Older Node |
| Trusted workspace | Restricted Mode: saved reports only |

Tested versions are in [`toolchain.json`](../toolchain.json): Node 22.22.2, Vitest 5.0.2, TypeScript 7.0.2 in the target.

## Target function

| Supported | Not supported |
|---|---|
| `.ts` source file inside the workspace folder | `.d.ts`, `*.test.ts`, `*.spec.ts`, files reached through a symlink that leaves the folder |
| Named `export function f(...) {}` | `export default`, classes, methods |
| `export const f = (...) => ...` or `= function (...) {}` | `let`/`var` exports |
| Synchronous, non-generic | `async`, generators, type parameters |

## Imports (whole closure, including imports of adjacent tests)

| Supported | Not supported |
|---|---|
| Relative static imports/re-exports with a `.js` (mapped to `.ts`) or `.ts` extension | Package imports, `node:` modules, path aliases, extensionless specifiers |
| | `require()`, `import x = require()`, dynamic `import()` |

## Baseline (existing) tests

Adjacent files are the baseline suite: `<name>.test.ts`, `<name>.spec.ts`, and `<name>.testforge.*.test.ts`. If one of them uses an unsupported feature, the run stops. The file is never silently ignored. `checkTestFile` rejects:

- `.only`, `.skip`, `.todo`, `.each`, `.concurrent`, `.skipIf`, `.runIf`, `.for`, `.fails`, `.extend` on `test`/`it`/`describe`/`expect`
- `beforeEach`, `afterEach`, `beforeAll`, `afterAll`, `vi`, `fit`, `xit`, `xtest`, `fdescribe`, `xdescribe`
- snapshot matchers (`toMatchSnapshot`, `toMatchInlineSnapshot`, `toThrowErrorMatching[Inline]Snapshot`, `toMatchFileSnapshot`)
- test titles that are not string literals, and `async` test callbacks
- importing anything from `vitest` other than `test`, `it`, `describe`, `expect`

No adjacent tests is allowed, but then there is no before/after comparison.

## JSON value contract (model output)

Arguments and expected return values must be plain JSON:

- `null`, booleans, finite numbers, strings (≤ 4,000 chars), arrays (≤ 100 items), plain objects
- nesting depth ≤ 8. No `__proto__`, `constructor` or `prototype` keys
- no `undefined`, `NaN`, `Infinity`, `Date`, `BigInt`, functions or class instances
- each case ≤ 8 KiB. Title ≤ 200 chars. ≤ 5 evidence refs per case. ≤ 12 cases per response (8 accepted per run)

The response must be one JSON object (schema v1). It may be wrapped in one outer ```` ```json ```` fence and must be ≤ 128 KiB. Evidence excerpts must appear in the cited lines, with whitespace normalized.

## Platforms

| Platform | Status |
|---|---|
| Linux x64 | Tested |
| macOS | Untested |
| Windows | Untested. The `taskkill` process-tree kill and `junction` link code paths are written but have never been run |

## Limits (`LIMITS` in `src/core/types.ts`)

| Limit | Value |
|---|---|
| Source files in import closure | 10 |
| Adjacent test files | 5 |
| Bytes per file | 64 KiB |
| Total context bytes | 128 KiB |
| Cases accepted per run / per response | 8 / 12 |
| Model requests per run | 3 (first request + one correction retry are used) |
| Model deadline per request | 45 s |
| Model response size | 128 KiB |
| Mutations sampled | 8 default, 20 max (`testforge.mutationSample`) |
| Per-test timeout | 2 s |
| Per-process deadline (tsc, Vitest) | 15 s |
| Global run deadline | 180 s default, 600 s max (`testforge.globalDeadlineSeconds`) |
| Captured process output | 1 MiB |
| History | 10 runs / 7 days |
| JSON depth / array / string | 8 / 100 / 4,000 |
| Title length / case size | 200 chars / 8 KiB |
