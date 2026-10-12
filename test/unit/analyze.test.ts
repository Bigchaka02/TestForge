import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { adjacentTestNames, analyzeTarget, findExports, findSecret, LOCKFILES, parse } from '../../src/analysis/analyze';
import { TestForgeError } from '../../src/core/types';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'testforge-unit-analyze-'));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let counter = 0;
interface ProjectOpts {
  files: Record<string, string>;
  pkg?: Record<string, unknown>;
  lockfile?: string | false; // default package-lock.json
  vitest?: string | null;
  typescript?: string | null;
  packages?: string[]; // other installed packages (package.json only)
}

/** Builds a minimal prepared project in a temp dir (fake node_modules metadata only). */
function project(o: ProjectOpts): string {
  const root = path.join(tmpRoot, `p${++counter}`);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(o.pkg ?? { name: 'p', type: 'module' }));
  if (o.lockfile !== false) fs.writeFileSync(path.join(root, o.lockfile ?? 'package-lock.json'), '{}');
  const mod = (name: string, version: string | null | undefined, fallback: string) => {
    if (version === null) return;
    fs.mkdirSync(path.join(root, 'node_modules', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: version ?? fallback }));
  };
  mod('vitest', o.vitest, '5.0.2');
  mod('typescript', o.typescript, '7.0.2');
  for (const name of o.packages ?? []) mod(name, undefined, '1.0.0');
  for (const [rel, text] of Object.entries(o.files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const OK_SRC = `import { MIN } from './limits.js';\n/** Doc. */\nexport function f(x: number): number {\n  return x >= MIN ? x : MIN;\n}\n`;

function rejection(root: string, file = 'src/m.ts', name = 'f'): TestForgeError {
  try {
    analyzeTarget(root, path.join(root, file), name);
  } catch (e) {
    expect(e).toBeInstanceOf(TestForgeError);
    return e as TestForgeError;
  }
  throw new Error('expected analyzeTarget to reject');
}

describe('findExports', () => {
  const src = `
export function ok(a: number): number { return a; }
export const arrowOk = (a: number) => a + 1;
export const fnExpr = function (a: number) { return a; };
export async function asyncFn() { return 1; }
export const asyncArrow = async () => 1;
export function* gen() { yield 1; }
export async function* asyncGen() { yield 1; }
export function generic<T>(a: T): T { return a; }
export const genericArrow = <T,>(a: T): T => a;
export default function def() { return 1; }
export class Klass {}
export let letArrow = () => 1;
function notExported() { return 1; }
export const notFn = 3;
export declare function decl(): void;
`;
  const byName = Object.fromEntries(findExports(parse('m.ts', src)).map((e) => [e.name, e]));

  test('eligible exports', () => {
    for (const n of ['ok', 'arrowOk', 'fnExpr']) expect(byName[n]).toMatchObject({ eligible: true, isAsync: false, reason: undefined });
    for (const n of ['asyncFn', 'asyncArrow']) expect(byName[n]).toMatchObject({ eligible: true, isAsync: true, reason: undefined });
    expect(byName.ok.line).toBe(2);
  });

  test.each([
    ['gen', /generators/],
    ['asyncGen', /generators/],
    ['generic', /generic/],
    ['genericArrow', /generic/],
    ['def', /default exports/],
    ['Klass', /classes/],
    ['letArrow', /const arrow/],
  ])('%s is ineligible', (name, reason) => {
    expect(byName[name].eligible).toBe(false);
    expect(byName[name].reason).toMatch(reason);
  });

  test('non-functions, non-exports and declarations are not listed', () => {
    expect(byName.notExported).toBeUndefined();
    expect(byName.notFn).toBeUndefined();
    expect(byName.decl).toBeUndefined();
  });
});

describe('analyzeTarget', () => {
  test('accepts a supported project and collects closure, tests and hashes', () => {
    const root = project({
      files: {
        'src/m.ts': OK_SRC,
        'src/limits.ts': 'export const MIN = 0;\n',
        'src/m.test.ts': "import { test, expect } from 'vitest';\nimport { f } from './m.js';\ntest('one', () => { expect(f(1)).toBe(1); });\n",
        'src/other.ts': 'export const unrelated = 1;\n',
        '.env': 'API_KEY="abcdefghijklmnop"\n',
      },
    });
    const a = analyzeTarget(root, path.join(root, 'src/m.ts'), 'f');
    expect(a.files.map((f) => [f.rel, f.role])).toEqual([
      ['src/m.ts', 'source'],
      ['src/limits.ts', 'source'],
      ['src/m.test.ts', 'test'],
    ]);
    expect(a.baselineTests).toEqual(['src/m.test.ts']);
    expect(Object.keys(a.packageHashes).sort()).toEqual(['package-lock.json', 'package.json']);
    expect(a.toolVersions).toEqual({ vitest: '5.0.2', typescript: '7.0.2' });
    expect(a.files[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toMatchObject({ externalImports: [], types: [], exclusions: [] });
  });

  test('accepts node: built-ins and installed packages (scoped, subpaths) without reading them', () => {
    const root = project({
      packages: ['lodash', '@scope/pkg', '@types/node'],
      files: {
        'src/m.ts': [
          "import { join } from 'node:path';",
          "import { readFile } from 'node:fs/promises';",
          "import chunk from 'lodash/chunk.js';",
          "import { x } from '@scope/pkg/sub';",
          "import type { T } from '@scope/pkg';",
          "import 'node:path';",
          "export * from 'lodash';",
          'export function f(a: number): number { return a; }',
        ].join('\n'),
        // Package code is never read: a secret in it would otherwise block the run.
        'node_modules/lodash/index.js': 'const password = "hunter2hunter2";\n',
      },
    });
    const a = analyzeTarget(root, path.join(root, 'src/m.ts'), 'f');
    expect(a.files.map((f) => f.rel)).toEqual(['src/m.ts']);
    expect(a.externalImports).toEqual(['node:path', 'node:fs/promises', 'lodash/chunk.js', '@scope/pkg/sub', '@scope/pkg', 'lodash']);
    expect(a.exclusions).toEqual([
      'Node built-in import node:path (not sent)',
      'Node built-in import node:fs/promises (not sent)',
      'package import lodash/chunk.js (not sent)',
      'package import @scope/pkg/sub (not sent)',
      'package import @scope/pkg (not sent)',
      'package import lodash (not sent)',
    ]);
    expect(a.types).toEqual(['node']);
  });

  test('baseline tests may import node: built-ins and installed packages too', () => {
    const root = project({
      packages: ['test-utils', '@types/node'],
      files: {
        'src/m.ts': OK_SRC,
        'src/limits.ts': 'export const MIN = 0;\n',
        'src/m.test.ts': "import { test, expect } from 'vitest';\nimport { strict } from 'node:assert';\nimport { helper } from 'test-utils';\nimport { f } from './m.js';\ntest('one', () => { strict.equal(f(1), helper(1)); });\n",
      },
    });
    const a = analyzeTarget(root, path.join(root, 'src/m.ts'), 'f');
    expect(a.baselineTests).toEqual(['src/m.test.ts']);
    expect(a.externalImports).toEqual(['node:assert', 'test-utils']);
    expect(a.types).toEqual(['node']);
  });

  test('installed packages alone do not add Node types to the execution copy', () => {
    const root = project({ packages: ['lodash'], files: { 'src/m.ts': "import { x } from 'lodash';\nexport function f(a: number): number { return a + x; }\n" } });
    expect(analyzeTarget(root, path.join(root, 'src/m.ts'), 'f')).toMatchObject({ externalImports: ['lodash'], types: [] });
  });

  test('node: built-ins need @types/node installed (a setup error, nothing is installed)', () => {
    const root = project({ files: { 'src/m.ts': "import { join } from 'node:path';\nexport function f(a: string): string { return join(a, 'x'); }\n" } });
    expect(rejection(root)).toMatchObject({ kind: 'setup', message: expect.stringMatching(/imports "node:path", which needs @types\/node.*never installs/) });
  });

  test.each([
    ["import { x } from 'lodash';", /imports "lodash"\. Only relative .ts imports, node: built-ins and packages installed in node_modules/],
    ["import { x } from 'lodash/fp.js';", /imports "lodash\/fp.js"\. Only relative/],
    ["import { x } from '@scope/missing';", /imports "@scope\/missing"\. Only relative/],
    ["import * as fs from 'fs';", /imports "fs"\. Import Node.js built-ins with the "node:" prefix \("node:fs"\)/],
    ["import * as fs from 'node:../fs';", /imports "node:..\/fs"\. It is not a Node.js built-in module name/],
    ["import { x } from '@/alias.js';", /imports "@\/alias.js"\. .*no path aliases/],
    ["import { x } from '~/alias.js';", /imports "~\/alias.js"\. .*no path aliases/],
    ["import { x } from '#internal';", /imports "#internal"\. .*no path aliases/],
    ["import { x } from '/abs/x.js';", /imports "\/abs\/x.js"\. Only relative/],
    ["import { x } from './noext';", /without a .js or .ts extension/],
    ["import { x } from './missing.js';", /does not exist/],
    ["export * from 'pkg';", /imports "pkg"/],
  ])('rejects imports: %s', (imp, reason) => {
    const root = project({ files: { 'src/m.ts': `${imp}\nexport function f(x: number): number { return x; }\n` } });
    const e = rejection(root);
    expect(e.kind).toBe('unsupported');
    expect(e.message).toMatch(reason);
  });

  test('rejects require()', () => {
    const root = project({ files: { 'src/m.ts': "export function f(x: number): number { const m = require('./x'); return x + m; }\n" } });
    expect(rejection(root).message).toMatch(/require\(\) is not supported/);
  });

  test('rejects dynamic import()', () => {
    const root = project({ files: { 'src/m.ts': "export function f(x: number): number { void import('./x.js'); return x; }\n" } });
    expect(rejection(root).message).toMatch(/dynamic import\(\) is not supported/);
  });

  test('require(), import = require() and import() stay rejected for installed packages', () => {
    const files = (body: string) => ({ packages: ['lodash'], files: { 'src/m.ts': `${body}\nexport function f(x: number): number { return x; }\n` } });
    expect(rejection(project(files("const _ = require('lodash');"))).message).toMatch(/require\(\) is not supported/);
    expect(rejection(project(files("import _ = require('lodash');"))).message).toMatch(/`import = require\(\)` is not supported/);
    expect(rejection(project(files("const _ = import('lodash');"))).message).toMatch(/dynamic import\(\) is not supported/);
  });

  test('rejects require() in a transitively imported file', () => {
    const root = project({ files: { 'src/m.ts': OK_SRC, 'src/limits.ts': "export const MIN = require('./zero');\n" } });
    expect(rejection(root).message).toMatch(/src\/limits.ts: require\(\)/);
  });

  test('accepts CommonJS packages ("type" missing or "commonjs"), rejects unknown types', () => {
    const files = { 'src/m.ts': OK_SRC, 'src/limits.ts': 'export const MIN = 0;\n' };
    for (const pkg of [{ name: 'p' }, { name: 'p', type: 'commonjs' }]) {
      const root = project({ pkg, files });
      expect(analyzeTarget(root, path.join(root, 'src/m.ts'), 'f').files.map((f) => f.rel)).toEqual(['src/m.ts', 'src/limits.ts']);
    }
    expect(rejection(project({ pkg: { name: 'p', type: 'esm' }, files }))).toMatchObject({ kind: 'unsupported', message: expect.stringMatching(/"type" must be "module" or "commonjs", not "esm"/) });
  });

  test('rejects workspaces', () => {
    const root = project({ pkg: { name: 'p', type: 'module', workspaces: ['a'] }, files: { 'src/m.ts': OK_SRC } });
    expect(rejection(root).message).toMatch(/[Ww]orkspaces/);
    const pnpm = project({ lockfile: 'pnpm-lock.yaml', files: { 'src/m.ts': OK_SRC, 'pnpm-workspace.yaml': "packages: ['a']\n" } });
    expect(rejection(pnpm).message).toMatch(/pnpm-workspace.yaml/);
  });

  test('rejects a missing lockfile, naming every accepted one', () => {
    const root = project({ lockfile: false, files: { 'src/m.ts': OK_SRC, 'src/limits.ts': 'export const MIN = 0;\n' } });
    expect(rejection(root)).toMatchObject({ kind: 'unsupported', message: expect.stringContaining('No lockfile was found (package-lock.json, pnpm-lock.yaml, yarn.lock, bun.lock, bun.lockb)') });
  });

  test.each(LOCKFILES)('accepts %s and hashes it', (lockfile) => {
    const root = project({ lockfile, files: { 'src/m.ts': OK_SRC, 'src/limits.ts': 'export const MIN = 0;\n' } });
    const a = analyzeTarget(root, path.join(root, 'src/m.ts'), 'f');
    expect(Object.keys(a.packageHashes).sort()).toEqual([lockfile, 'package.json'].sort());
    expect(a.packageHashes[lockfile]).toMatch(/^[0-9a-f]{64}$/);
  });

  test('hashes every lockfile present', () => {
    const root = project({ lockfile: 'yarn.lock', files: { 'src/m.ts': OK_SRC, 'src/limits.ts': 'export const MIN = 0;\n', 'package-lock.json': '{}' } });
    expect(Object.keys(analyzeTarget(root, path.join(root, 'src/m.ts'), 'f').packageHashes).sort()).toEqual(['package-lock.json', 'package.json', 'yarn.lock']);
  });

  test('missing or unsupported tools are setup errors', () => {
    const files = { 'src/m.ts': OK_SRC, 'src/limits.ts': 'export const MIN = 0;\n' };
    expect(rejection(project({ vitest: null, files })).kind).toBe('setup');
    expect(rejection(project({ vitest: '4.1.0', files })).message).toMatch(/vitest 4.1.0 is not supported/);
    expect(rejection(project({ typescript: '5.9.0', files })).message).toMatch(/typescript 5.9.0 is not supported/);
    expect(() => analyzeTarget(project({ typescript: '6.0.3', files }), path.join(tmpRoot, `p${counter}`, 'src/m.ts'), 'f')).not.toThrow();
  });

  const VITEST_IMPORT = "import { test, it, describe, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';";

  test.each([
    ["test.only('x', () => { expect(f(1)).toBe(1); });", /`test.only` is not supported/],
    ["describe.only('g', () => { it('x', () => {}); });", /`describe.only` is not supported/],
    ["test.skip.only('x', () => {});", /`test.skip.only` is not supported/],
    ["it.concurrent('x', () => {});", /`it.concurrent` is not supported/],
    ["describe.skip.concurrent('g', () => {});", /`describe.skip.concurrent` is not supported/],
    ["test.skipIf(true)('x', () => {});", /`test.skipIf` is not supported/],
    ["test.runIf(true)('x', () => {});", /`test.runIf` is not supported/],
    ["test.fails('x', () => {});", /`test.fails` is not supported/],
    ["const t2 = test.extend({});\nt2('x', () => {});", /`test.extend` is not supported/],
    ["xit('x', () => {});", /`xit` is not supported/],
    ["fdescribe('g', () => {});", /`fdescribe` is not supported/],
    ["test('x', () => { expect(f(1)).toMatchSnapshot(); });", /snapshots/],
    ["test('x', () => { expect(f(1)).toMatchInlineSnapshot(); });", /snapshots/],
    ["test('x', () => { expect(() => f(1)).toThrowErrorMatchingInlineSnapshot(); });", /snapshots/],
    ["test('x', async () => { await expect(f(1)).toMatchFileSnapshot('x.txt'); });", /snapshots/],
  ])('rejects unsupported baseline tests: %s', (body, reason) => {
    const root = project({
      files: {
        'src/m.ts': OK_SRC,
        'src/limits.ts': 'export const MIN = 0;\n',
        'src/m.spec.ts': `${VITEST_IMPORT}\nimport { f } from './m.js';\n${body}\n`,
      },
    });
    const e = rejection(root);
    expect(e.kind).toBe('unsupported');
    expect(e.message).toMatch(/Existing test src\/m.spec.ts uses unsupported features/);
    expect(e.message).toMatch(reason);
  });

  test.each([
    ['hooks', "let n = 0;\nbeforeAll(() => { n = 1; });\nbeforeEach(() => { n++; });\nafterEach(() => { n--; });\nafterAll(() => { n = 0; });\ntest('x', () => { expect(f(n)).toBe(2); });"],
    ['vi mocks and spies', "test('x', () => { const spy = vi.fn(f); spy(1); expect(spy).toHaveBeenCalledOnce(); vi.restoreAllMocks(); });"],
    ['skip and todo', "it.skip('x', () => {});\ntest.todo('later');\ndescribe.skip('g', () => { it('y', () => {}); });\ndescribe.todo('h');"],
    ['each and for', "test.each([[1, 1], [2, 2]])('f(%i) = %i', (a, b) => { expect(f(a)).toBe(b); });\nit.for([1])('for %i', (a) => { expect(f(a)).toBe(a); });\ndescribe.each([1])('group %i', (a) => { it('inner', () => { expect(f(a)).toBe(a); }); });\ntest.skip.each([1])('skipped %i', () => {});"],
    ['computed titles', "const name = 'x';\ntest(name, () => {});\nit(`t ${name}`, () => {});\ndescribe(f.name, () => { it('y', () => {}); });"],
  ])('accepts baseline tests with %s', (_label, body) => {
    const root = project({
      files: {
        'src/m.ts': OK_SRC,
        'src/limits.ts': 'export const MIN = 0;\n',
        'src/m.spec.ts': `${VITEST_IMPORT}\nimport { f } from './m.js';\n${body}\n`,
      },
    });
    expect(analyzeTarget(root, path.join(root, 'src/m.ts'), 'f').baselineTests).toEqual(['src/m.spec.ts']);
  });

  test('rejects other vitest imports in baseline tests', () => {
    const root = project({
      files: {
        'src/m.ts': OK_SRC,
        'src/limits.ts': 'export const MIN = 0;\n',
        'src/m.test.ts': "import { test, vi, bench, onTestFinished } from 'vitest';\ntest('x', () => {});\n",
      },
    });
    expect(rejection(root).message).toMatch(/imports bench, onTestFinished from vitest; only test, it, expect, describe, beforeEach, afterEach, beforeAll, afterAll, vi are supported/);
  });

  test('test helpers that import vitest follow the baseline test rules', () => {
    const files = (helper: string) => ({
      files: {
        'src/m.ts': OK_SRC,
        'src/limits.ts': 'export const MIN = 0;\n',
        'src/m.test.ts': "import { test } from 'vitest';\nimport { check } from '../test/helpers.js';\nimport { f } from './m.js';\ntest('x', () => { check(f(1)); });\n",
        'test/helpers.ts': helper,
      },
    });
    const ok = project(files("import { expect, vi } from 'vitest';\nexport function check(n: number): void { vi.fn()(); expect(n).toBe(1); }\n"));
    const a = analyzeTarget(ok, path.join(ok, 'src/m.ts'), 'f');
    expect(a.files.map((f) => [f.rel, f.role])).toEqual([
      ['src/m.ts', 'source'],
      ['src/limits.ts', 'source'],
      ['src/m.test.ts', 'test'],
      ['test/helpers.ts', 'source'],
    ]);
    expect(a.externalImports).toEqual([]);
    expect(rejection(project(files("import { bench } from 'vitest';\nexport const check = (n: number) => bench;\n"))).message).toBe(
      'test/helpers.ts imports bench from vitest; only test, it, expect, describe, beforeEach, afterEach, beforeAll, afterAll, vi are supported.',
    );
    // Re-exports are imports too.
    expect(rejection(project(files("export * from 'vitest';\nexport const check = (n: number) => n;\n"))).message).toMatch(/^test\/helpers.ts imports \* from vitest; only test, it/);
    expect(rejection(project(files("export { expect, onTestFinished as done } from 'vitest';\nexport const check = (n: number) => n;\n"))).message).toMatch(/^test\/helpers.ts imports onTestFinished from vitest/);
    expect(rejection(project(files("import { expect, test } from 'vitest';\nexport const focus = test.only;\nexport function check(n: number): void { expect(n).toMatchSnapshot(); }\n"))).message).toBe(
      'Test helper test/helpers.ts uses unsupported features: `test.only` is not supported; snapshots are not supported. TestForge will not silently ignore it.',
    );
  });

  test.each([
    ['const key = "AKIAABCDEFGHIJKLMNOP";'],
    ['const password = "hunter2hunter2";'],
    ['const k = "-----BEGIN RSA PRIVATE KEY-----";'],
    ['const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";'],
  ])('stops on likely secrets: %s', (line) => {
    const root = project({ files: { 'src/m.ts': OK_SRC, 'src/limits.ts': `export const MIN = 0;\n${line}\n` } });
    const e = rejection(root);
    expect(e.kind).toBe('blocked');
    expect(e.message).toMatch(/src\/limits.ts:2 looks like it contains a secret/);
  });

  test('findSecret ignores ordinary code', () => {
    expect(findSecret('const password = input;\nconst token = getToken();\n')).toBeUndefined();
  });

  test('rejects ineligible or missing exports with the reason', () => {
    const root = project({ files: { 'src/m.ts': 'export function* f() { yield 1; }\n' } });
    expect(rejection(root).message).toBe('f: generators are not supported.');
    const root2 = project({ files: { 'src/m.ts': 'export function g() { return 1; }\n' } });
    expect(rejection(root2).message).toMatch(/No named exported function "f"/);
  });

  test('rejects test files and declarations as targets', () => {
    const root = project({ files: { 'src/m.test.ts': '', 'src/m.d.ts': '' } });
    expect(rejection(root, 'src/m.test.ts').kind).toBe('unsupported');
    expect(rejection(root, 'src/m.d.ts').kind).toBe('unsupported');
  });

  test('rejects symlinks that leave the workspace', () => {
    const outside = path.join(tmpRoot, `outside${counter}.ts`);
    fs.writeFileSync(outside, 'export const MIN = 0;\n');
    const root = project({ files: { 'src/m.ts': OK_SRC } });
    fs.symlinkSync(outside, path.join(root, 'src/limits.ts'));
    expect(rejection(root).message).toMatch(/outside the workspace/);
  });
});

describe('baseline test discovery', () => {
  const BASE = { 'src/m.ts': OK_SRC, 'src/limits.ts': 'export const MIN = 0;\n' };
  const T = (from: string, body = "test('t', () => { expect(f(1)).toBe(1); });") => `import { test, expect } from 'vitest';\nimport { f } from '${from}';\n${body}\n`;
  const rels = (root: string, abs: string[]) => abs.map((t) => path.relative(root, t).split(path.sep).join('/'));

  test('finds __tests__ files and test/ or tests/ files that import the module, after adjacent ones', () => {
    const root = project({
      files: {
        ...BASE,
        'src/m.test.ts': T('./m.js'),
        'src/__tests__/m.test.ts': T('../m.js'),
        'src/__tests__/m.spec.ts': T('../m.ts'),
        'test/m.test.ts': T('../src/m.js'),
        'tests/unit/deep/m.spec.ts': T('../../../src/m.js'),
      },
    });
    const a = analyzeTarget(root, path.join(root, 'src/m.ts'), 'f');
    expect(a.baselineTests).toEqual(['src/m.test.ts', 'src/__tests__/m.spec.ts', 'src/__tests__/m.test.ts', 'test/m.test.ts', 'tests/unit/deep/m.spec.ts']);
    expect(a.files.filter((f) => f.role === 'test').map((f) => f.rel)).toEqual(a.baselineTests);
  });

  test('ignores same-name files that do not import the module (they are not even checked)', () => {
    const root = project({
      files: {
        ...BASE,
        'lib/m.ts': 'export const f = (x: number) => x;\n',
        'src/__tests__/m.test.ts': T('../limits.js', "test.only('x', () => {});"),
        'test/m.test.ts': T('../lib/m.js', "test.only('x', () => {});"),
        'test/legacy/m.spec.ts': "import { test } from 'vitest';\ntest.only('x', () => {});\n",
        'test/node_modules/m.test.ts': T('../../src/m.js'),
        'test/.cache/m.test.ts': T('../../src/m.js'),
        'test/m.helper.ts': T('../src/m.js'),
        'lib/test/m.test.ts': T('../../src/m.js'),
        'src/__tests__/deeper/m.test.ts': T('../../m.js'),
      },
    });
    expect(analyzeTarget(root, path.join(root, 'src/m.ts'), 'f').baselineTests).toEqual([]);
  });

  test('a discovered test with an unsupported import is reported, not silently ignored', () => {
    const root = project({ files: { ...BASE, 'test/m.test.ts': T('../src/m') } });
    expect(rejection(root).message).toBe('test/m.test.ts imports "../src/m" without a .js or .ts extension.');
  });

  test('without a root, only the module folder is searched (adjacent files and __tests__)', () => {
    const root = project({ files: { ...BASE, 'src/__tests__/m.test.ts': T('../m.js'), 'test/m.test.ts': T('../src/m.js') } });
    const src = path.join(root, 'src/m.ts');
    expect(rels(root, adjacentTestNames(src))).toEqual(['src/__tests__/m.test.ts']);
    expect(rels(root, adjacentTestNames(src, root))).toEqual(['src/__tests__/m.test.ts', 'test/m.test.ts']);
  });

  test('the limit of 5 baseline test files counts every location', () => {
    const root = project({
      files: {
        ...BASE,
        'src/m.test.ts': T('./m.js'),
        'src/m.spec.ts': T('./m.js'),
        'src/__tests__/m.test.ts': T('../m.js'),
        'test/m.test.ts': T('../src/m.js'),
        'test/a/m.spec.ts': T('../../src/m.js'),
        'tests/m.test.ts': T('../src/m.js'),
      },
    });
    expect(rejection(root).message).toBe('There are 6 baseline test files (limit 5).');
  });

  // Creating symlinks on Windows needs extra privileges.
  test.skipIf(process.platform === 'win32')('symlinked test files and folders are not followed', () => {
    const root = project({ files: { ...BASE, 'elsewhere/m.test.ts': T('../src/m.js') } });
    fs.mkdirSync(path.join(root, 'test'));
    fs.symlinkSync(path.join(root, 'elsewhere/m.test.ts'), path.join(root, 'test/m.test.ts'));
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'test/linked'));
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'tests'));
    expect(analyzeTarget(root, path.join(root, 'src/m.ts'), 'f').baselineTests).toEqual([]);
  });
});
