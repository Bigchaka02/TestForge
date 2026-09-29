# Privacy and execution safety

## What is sent to the model

Only when you run **Generate & Verify Tests** with a real model, and only after you consent:

- The instructions, the response schema, and the target export name and file path.
- The full text of every file in the target's **relative import closure** and of its **adjacent test files** (`x.test.ts`, `x.spec.ts`, `x.testforge.*.test.ts`), plus files those tests import relatively. Each file is labeled with an ID (`F1`, `F2`, ...) and its workspace-relative path, and every line is numbered.
- The titles of existing tests.
- On a correction retry: the previous prompt, the model's reply, and the validation error.

Bounds: ≤ 10 source files, ≤ 5 test files, ≤ 64 KiB per file, ≤ 128 KiB in total. The token count is checked against the model's `maxInputTokens` before sending.

The demo command (**Run Demo**) sends nothing anywhere. It uses a local fake provider.

## What is never read

TestForge only reads files reached by relative `.ts`/`.js` imports from the target, plus its adjacent tests. It does not scan the workspace. `.env` files, keys, configs, git data and other source files are excluded by construction, not by filtering. Apart from those files, analysis reads only `package.json`, `package-lock.json` (hashed, not sent) and the `version` field of `node_modules/vitest` and `node_modules/typescript`.

## Secret detection

Each file is checked against a few regexes before it is included: private-key headers, AWS access key IDs, GitHub tokens, `sk-` keys, and `api_key/secret/password/token = "..."` assignments. On a match, the run **stops** with status `blocked` and names the file and line. Nothing is sent. This is **best-effort**: it can miss secrets and can flag false positives.

## Consent

A modal dialog asks before the first run. It lists the files that will be sent and states that code will be executed. **Show Outgoing Context** opens the exact prompt read-only. The answer is stored in workspace state per **workspace + model label + consent policy version** (`CONSENT_POLICY_VERSION = 1`), so a new model or a policy change asks again. Demo mode asks once per workspace too, because it still executes code. VS Code's Language Model API may add its own permission prompt.

## Logging and retention

- The output channel records the export name, the relative file path, the model label, stage messages and the final status/error message. **It never records file contents.** The only code fragments in it are the operator tokens of mutations (for example `>= → >`). Error messages can include failing test titles.
- Run reports are stored locally in VS Code workspace state (per workspace). Reports contain the generated test source, case data (including evidence excerpts quoted from your files), test titles and failure messages, but not whole source files. The newest **10 runs** are kept, none older than **7 days**. **TestForge: Clear History** deletes them all, and **Discard Run** deletes one.
- Temporary run directories are removed at the end of every run. Leftovers older than 1 day, and only those carrying TestForge's ownership sentinel, are removed on activation.

## Execution disclosure

**TestForge runs your code and your tests (through your installed `tsc` and `vitest`) in temporary copies of the relevant files. A temporary copy is NOT an operating-system sandbox: the code runs as your user, with your file-system and network access. `node_modules` is linked, not copied. Only run TestForge on code you trust.**

What is limited:

- Processes are spawned with `shell: false` and use TestForge's own Vitest config and tsconfig (no setup files, no global setup).
- The child environment is filtered (`childEnv` in `src/execution/runner.ts`). Only `PATH`/`Path`, `HOME`, `USERPROFILE`, `SYSTEMROOT`/`SystemRoot`, `WINDIR`, `COMSPEC` and `PATHEXT` are passed through. `TMPDIR`/`TEMP`/`TMP` point into the run directory, and `CI=1`, `TZ=UTC`, `LANG`/`LC_ALL=C.UTF-8`, `NODE_ENV=test`, `FORCE_COLOR=0`, `NO_COLOR=1` are set. Tokens and other variables from your shell are not passed.
- Every process has a deadline (15 s, and 2 s per test) and a 1 MiB output cap. It is killed with its process group on timeout or cancel.
- Generating and running require a trusted workspace.
