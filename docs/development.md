# Development

Tested with Node 22.22.2 and npm 10.9.7 on Linux x64 (see [`toolchain.json`](../toolchain.json)).

## Setup

```sh
npm ci                     # extension dev dependencies
npm run fixtures:install   # npm ci in every fixtures/* project (pinned vitest 5.0.2, typescript 7.0.2)
```

## Scripts

| Script | What it does |
|---|---|
| `build` | esbuild bundles `src/extension.ts` into `dist/extension.js` (CJS, `vscode` external, typescript/zod bundled) |
| `watch` | Same, rebuilding on change |
| `lint` | ESLint over `src` and `test` |
| `typecheck` | `tsc --noEmit -p .` |
| `test:unit` | Vitest over `test/unit` (vscode-free modules) |
| `test:integration` | Vitest over `test/integration`: the real pipeline on `fixtures/sample` and `fixtures/realistic` with the fake provider and real tsc/Vitest processes. Needs `fixtures:install` first |
| `test:extension` | Builds, compiles `test/extension` to `out/`, and runs `vscode-test` (config: `.vscode-test.mjs`) with `fixtures/sample` as the workspace |
| `fixtures:install` | Runs `npm ci` in each `fixtures/*` directory |
| `package` | Builds and runs `vsce package --no-dependencies -o testforge.vsix` |
| `package:check` | `scripts/verify-package.mjs`: inspects the built `testforge.vsix` and `dist/extension.js` |
| `verify` | lint → typecheck → test:unit → test:integration → package → package:check → test:extension. Stops at the first failure |

**Note:** `test:extension` downloads VS Code from `update.code.visualstudio.com`. In the container where TestForge is built, that host is blocked (403), so CI runs it instead. If the download fails, the step exits non-zero; it does not pass silently. Set `TESTFORGE_VSCODE_VERSION` to pin a VS Code version.

## CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`, on `ubuntu-latest`, `macos-latest` and `windows-latest` with Node 22: `npm ci`, `fixtures:install`, lint, typecheck, unit and integration tests, package, package check, then the extension-host smoke suite in a real VS Code (under `xvfb-run` on Linux). The Linux job uploads `testforge.vsix` as the `testforge-vsix` artifact.

The smoke suite sets `TESTFORGE_TEST_CONSENT=1` (in `.vscode-test.mjs`). Only in `ExtensionMode.Test` does that skip the consent dialog and the chat tools' confirmation, so a headless host does not block. Extension-host tests print TestForge's output channel lines with a `[TestForge]` prefix, so a CI log says why a run did not start.

## Extension Development Host

1. `npm ci && npm run fixtures:install`
2. Open this repo in VS Code and press F5 ("Run Extension"). The launch config builds first and opens `fixtures/sample` in the new window.
3. Trust the workspace when asked.
4. "Extension Tests" in the same launch file runs the smoke suite inside the host.

## Manual live-model smoke test

Needs a model available through VS Code's Language Model API (for example, GitHub Copilot signed in).

1. Launch the Extension Development Host as above.
2. Run **TestForge: Select Model** and pick a model.
3. Open `src/age.ts` and click **Generate & Verify Tests** above `isEligible`.
4. Accept the consent dialog (try **Show Outgoing Context** first). It is shown once per workspace, model and policy version.
5. Check that the progress notification moves through the stages and that Cancel works.
6. Check the **TestForge Results** view: the model label is not `DEMO`, cases list their basis and evidence, and there are mutation results.
7. **Preview Generated Tests**, then **Apply Tests**. Check that `src/age.testforge.<runId>.test.ts` is created and that a second Apply does not create another file.
8. Check the TestForge output channel. It must contain no file contents, only names, paths, stages and mutation operator tokens.
9. Repeat on `src/discount.ts` (expect a failing candidate kept for review and a possible-bug warning) and `src/slow.ts` (expect a timeout).
10. Click **Audit Tests** above `isEligible` (no model): expect 1/3 detected.
11. In Copilot agent mode, ask the agent to use `#testforgeAudit` on `src/age.ts`. Check the confirmation text, the result (score, surviving changes, next step), and that **Always Allow** skips the confirmation next time. Then try `#testforge`.
12. **Copy Test Proof (Markdown)** and paste it into a GitHub comment preview.

Record the result in `docs/progress.md`. This check is manual. No automated test covers the real model or a real agent-mode session.
