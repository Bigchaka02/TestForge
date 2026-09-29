# TestForge

TestForge is a VS Code extension that proposes Vitest tests for one exported TypeScript function and then checks them. A language model (through VS Code's Language Model API) returns test cases as **data only**. TestForge validates them, renders the tests from a fixed template, and runs them against temporary copies of your code. It then reports which small code changes (mutations) your existing tests and the new tests detect. All numbers come from real `tsc` and Vitest runs. Nothing is written to your workspace until you click **Apply**.

## The one-click flow

1. Open a `.ts` file and click **TestForge: Generate & Verify Tests** above an exported function.
2. Approve the consent dialog. It lists the files that will be sent and warns that code will be executed.
3. TestForge checks support → runs existing tests twice → asks the model → validates → runs the generated tests twice → checks mutations.
4. Read the **TestForge Results** view (Explorer): cases with basis and evidence, pass/fail against current code, and mutation scores for the existing tests vs. with the generated tests.
5. **Preview Generated Tests**, then **Apply Tests**. This creates `<module>.testforge.<runId>.test.ts` next to the module and never overwrites a file.

## Install

```sh
npm ci && npm run package          # builds testforge.vsix
code --install-extension testforge.vsix
```

## Prerequisites for a target project

- One npm package with `"type": "module"` and a `package-lock.json`
- `vitest` 5.x and `typescript` 6.x or 7.x **already installed** locally. TestForge never installs packages
- Node.js ≥ 22.12.0 on `PATH` (or set `testforge.nodePath`)
- A trusted workspace
- A model available through VS Code's Language Model API (for example GitHub Copilot), **or** use **Run Demo**, which uses a labeled fake model and needs no AI

The full list of what is supported is in [docs/support-matrix.md](docs/support-matrix.md).

## Commands

| Command | What it does |
|---|---|
| TestForge: Generate & Verify Tests | Runs the flow for the function under the cursor. If that is ambiguous, it asks you to pick one |
| TestForge: Run Demo (fake model, no AI) | Same flow with a deterministic fake provider. Reports are labeled DEMO |
| TestForge: Select Model | Picks the language model to use |
| TestForge: Cancel Run | Cancels the active run and kills its processes |
| TestForge: Open Report | Opens a saved report (also works in Restricted Mode) |
| TestForge: Preview Generated Tests | Shows the generated file read-only |
| TestForge: Apply Tests | Creates the test file. Disabled when results are stale or a case fails |
| TestForge: Apply Failing Candidate | Applies cases that fail against the current code, after a confirmation |
| TestForge: Discard Run | Removes the current report |
| TestForge: Clear History | Deletes all saved reports for this workspace |

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `testforge.nodePath` | `""` | Node.js executable. Empty means search `PATH` |
| `testforge.mutationSample` | `8` | Mutations to check (1–20) |
| `testforge.globalDeadlineSeconds` | `180` | Overall run deadline (30–600) |
| `testforge.requirementsFile` | `""` | **Placeholder, not used yet** |

## Limitations

- **Temporary copies are not a sandbox.** Your code and tests run as you. See [docs/privacy.md](docs/privacy.md).
- Only named, synchronous, non-generic exported functions with relative `.ts` imports are supported. Default exports, classes, async functions, package imports and CommonJS are not.
- There are only three mutation families, and each run checks a sample (8 by default). Mutations are hypothetical faults, not bugs.
- The improvement pass (a second model request for surviving mutations) is a **placeholder**.
- Secret detection is best-effort.
- Tested on Linux x64 only. macOS and Windows are untested.
- The extension-host test suite has not been run in the build environment (the VS Code download is blocked there).

## Docs

[Architecture](docs/architecture.md) · [Decisions](docs/decisions.md) · [Support matrix](docs/support-matrix.md) · [Privacy & execution](docs/privacy.md) · [Demo](docs/demo.md) · [Development](docs/development.md) · [Plan](docs/plan.md)

License: MIT.
