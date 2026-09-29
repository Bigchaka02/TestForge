// Checks the packaged VSIX and the bundle after `npm run package`.
// Usage: node scripts/verify-package.mjs [path/to/file.vsix] [path/to/extension.js]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';

const vsix = process.argv[2] ?? 'testforge.vsix';
const bundle = process.argv[3] ?? 'dist/extension.js';
const problems = [];

if (!existsSync(vsix)) {
  console.error(`verify-package: ${vsix} not found. Run \`npm run package\` first.`);
  process.exit(1);
}

// 1. VSIX contents (a zip). `unzip -Z1` prints one entry path per line.
let entries;
try {
  entries = execFileSync('unzip', ['-Z1', vsix], { encoding: 'utf8' }).split('\n').filter(Boolean);
} catch (err) {
  console.error(`verify-package: could not list ${vsix} with unzip: ${err.message}`);
  process.exit(1);
}
console.log(`${vsix}: ${entries.length} entries`);
for (const e of entries) console.log(`  ${e}`);

const forbidden = [
  [/^extension\/src\//, 'source files (src/)'],
  [/^extension\/test\//, 'tests (test/)'],
  [/^extension\/out\//, 'compiled tests (out/)'],
  [/^extension\/fixtures\//, 'fixtures (fixtures/)'],
  [/^extension\/scripts\//, 'scripts (scripts/)'],
  [/(^|\/)node_modules\//, 'node_modules/'],
  [/(^|\/)\.env(\..*)?$/, '.env file'],
  [/\.pem$/i, 'PEM key/certificate'],
  [/\.key$/i, 'key file'],
];
for (const e of entries) {
  for (const [re, what] of forbidden) {
    if (re.test(e)) problems.push(`VSIX contains ${what}: ${e}`);
  }
}
for (const required of ['extension/package.json', 'extension/dist/extension.js']) {
  if (!entries.includes(required)) problems.push(`VSIX is missing ${required}`);
}

// 2. Bundle must only require vscode and Node built-ins.
if (!existsSync(bundle)) {
  problems.push(`${bundle} not found`);
} else {
  const code = readFileSync(bundle, 'utf8');
  const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
  const required = new Set();
  for (const m of code.matchAll(/\brequire\(\s*(["'`])([^"'`]+)\1\s*\)/g)) required.add(m[2]);
  // Optional requires that bundled libraries wrap in try/catch and that are
  // absent at runtime on purpose. typescript: `try { require("source-map-support").install() } catch {}`.
  const optional = new Set(['source-map-support']);
  const bad = [...required].filter((m) => m !== 'vscode' && !optional.has(m) && !builtins.has(m) && !builtins.has(m.split('/')[0]));
  console.log(`${bundle}: requires ${[...required].sort().join(', ') || '(nothing)'}`);
  for (const m of bad) problems.push(`${bundle} requires non-bundled module "${m}"`);
}

if (problems.length > 0) {
  console.error(`\nverify-package: FAILED (${problems.length} problem(s))`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nverify-package: OK');
