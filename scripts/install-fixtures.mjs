// Installs the pinned toolchain into each fixture project (development setup only).
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
for (const name of readdirSync('fixtures')) {
  const dir = join('fixtures', name);
  console.log(`npm ci in ${dir}`);
  execFileSync(npm, ['ci', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
}
