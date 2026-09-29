// Extension-host smoke tests (@vscode/test-cli). Run with `npm run test:extension`.
// Needs to download VS Code from update.code.visualstudio.com; when that fails
// the CLI exits non-zero, so the gate fails loudly instead of passing silently.
import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  label: 'smoke',
  files: 'out/test/extension/**/*.test.js',
  workspaceFolder: 'fixtures/sample',
  version: process.env.TESTFORGE_VSCODE_VERSION ?? 'stable',
  launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
  env: { TESTFORGE_TEST_CONSENT: '1' },
  mocha: {
    ui: 'bdd',
    timeout: 120_000,
  },
});
