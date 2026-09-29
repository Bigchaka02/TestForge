// Mocha entry used by the "Extension Tests" launch configuration
// (--extensionTestsPath). `npm run test:extension` uses @vscode/test-cli instead.
import * as fs from 'node:fs';
import * as path from 'node:path';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 120_000 });
  for (const f of fs.readdirSync(__dirname)) {
    if (f.endsWith('.test.js')) mocha.addFile(path.join(__dirname, f));
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} extension test(s) failed`)) : resolve()));
  });
}
