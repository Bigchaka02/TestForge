import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { analyzeTarget, findExports, findSecret, parse } from '../../src/analysis/analyze';
import { TestForgeError } from '../../src/core/types';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'testforge-unit-analyze-'));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let counter = 0;
interface ProjectOpts {
  files: Record<string, string>;
  pkg?: Record<string, unknown>;
  lockfile?: boolean;
  vitest?: string | null;
  typescript?: string | null;
}

/** Builds a minimal prepared project in a temp dir (fake node_modules metadata only). */
function project(o: ProjectOpts): string {
  const root = path.join(tmpRoot, `p${++counter}`);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(o.pkg ?? { name: 'p', type: 'module' }));
  if (o.lockfile !== false) fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  const mod = (name: string, version: string | null | undefined, fallback: string) => {
    if (version === null) return;
    fs.mkdirSync(path.join(root, 'node_modules', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: version ?? fallback }));
  };
  mod('vitest', o.vitest, '5.0.2');
  mod('typescript', o.typescript, '7.0.2');
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
    for (const n of ['ok', 'arrowOk', 'fnExpr']) expect(byName[n]).toMatchObject({ eligible: true, reason: undefined });
    expect(byName.ok.line).toBe(2);
  });

  test.each([
    ['asyncFn', /async/],
    ['asyncArrow', /async/],
    ['gen', /generators/],
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
  });

  test.each([
    ["import { x } from 'lodash';", /imports "lodash"/],
    ["import * as fs from 'node:fs';", /imports "node:fs"/],
    ["import { x } from '@/alias.js';", /imports "@\/alias.js"/],
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

  test('rejects require() in a transitively imported file', () => {
    const root = project({ files: { 'src/m.ts': OK_SRC, 'src/limits.ts': "export const MIN = require('./zero');\n" } });
    expect(rejection(root).message).toMatch(/src\/limits.ts: require\(\)/);
  });

  test('rejects CommonJS packages', () => {
    const root = project({ pkg: { name: 'p' }, files: { 'src/m.ts': OK_SRC } });
    expect(rejection(root)).toMatchObject({ kind: 'unsupported', message: expect.stringMatching(/CommonJS/) });
    const root2 = project({ pkg: { name: 'p', type: 'commonjs' }, files: { 'src/m.ts': OK_SRC } });
    expect(rejection(root2).message).toMatch(/CommonJS/);
  });

  test('rejects workspaces', () => {
    const root = project({ pkg: { name: 'p', type: 'module', workspaces: ['a'] }, files: { 'src/m.ts': OK_SRC } });
    expect(rejection(root).message).toMatch(/workspaces/);
  });

  test('rejects a missing lockfile', () => {
    const root = project({ lockfile: false, files: { 'src/m.ts': OK_SRC, 'src/limits.ts': 'export const MIN = 0;\n' } });
    expect(rejection(root)).toMatchObject({ kind: 'unsupported', message: expect.stringMatching(/package-lock.json is missing/) });
  });

  test('missing or unsupported tools are setup errors', () => {
    const files = { 'src/m.ts': OK_SRC, 'src/limits.ts': 'export const MIN = 0;\n' };
    expect(rejection(project({ vitest: null, files })).kind).toBe('setup');
    expect(rejection(project({ vitest: '4.1.0', files })).message).toMatch(/vitest 4.1.0 is not supported/);
    expect(rejection(project({ typescript: '5.9.0', files })).message).toMatch(/typescript 5.9.0 is not supported/);
    expect(() => analyzeTarget(project({ typescript: '6.0.3', files }), path.join(tmpRoot, `p${counter}`, 'src/m.ts'), 'f')).not.toThrow();
  });

  test.each([
    ["test.only('x', () => { expect(f(1)).toBe(1); });", /test.only/],
    ["it.skip('x', () => {});", /it.skip/],
    ["test.each([1])('x %s', () => {});", /test.each/],
    ["beforeEach(() => {});\ntest('x', () => {});", /beforeEach/],
    ["test('x', () => { expect(f(1)).toMatchSnapshot(); });", /snapshots/],
    ["test('x', () => { expect(f(1)).toMatchInlineSnapshot(); });", /snapshots/],
    ["test('x', async () => { expect(f(1)).toBe(1); });", /async tests/],
    ["const name = 'x';\ntest(name, () => {});", /titles must be string literals/],
  ])('rejects unsupported baseline tests: %s', (body, reason) => {
    const root = project({
      files: {
        'src/m.ts': OK_SRC,
        'src/limits.ts': 'export const MIN = 0;\n',
        'src/m.spec.ts': `import { test, it, expect } from 'vitest';\nimport { f } from './m.js';\n${body}\n`,
      },
    });
    const e = rejection(root);
    expect(e.kind).toBe('unsupported');
    expect(e.message).toMatch(/Existing test src\/m.spec.ts uses unsupported features/);
    expect(e.message).toMatch(reason);
  });

  test('rejects vi and hook imports from vitest in baseline tests', () => {
    const root = project({
      files: {
        'src/m.ts': OK_SRC,
        'src/limits.ts': 'export const MIN = 0;\n',
        'src/m.test.ts': "import { test, vi } from 'vitest';\ntest('x', () => {});\n",
      },
    });
    expect(rejection(root).message).toMatch(/imports vi from vitest/);
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
    const root = project({ files: { 'src/m.ts': 'export async function f() { return 1; }\n' } });
    expect(rejection(root).message).toBe('f: async functions are not supported.');
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
