import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { cleanupStale, createCopy, createRunDir, removeRunDir, SENTINEL, writeFile } from '../../src/execution/workspace';
import { TestForgeError } from '../../src/core/types';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'testforge-unit-ws-'));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(base, 'case-'));
});

describe('run directories', () => {
  test('createRunDir writes a sentinel and a tmp dir', () => {
    const run = createRunDir('abcd', dir);
    expect(path.basename(run.root)).toMatch(/^testforge-run-abcd-/);
    expect(JSON.parse(fs.readFileSync(path.join(run.root, SENTINEL), 'utf8'))).toMatchObject({ owner: 'testforge', runId: 'abcd' });
    expect(fs.statSync(run.tmp).isDirectory()).toBe(true);
    expect(removeRunDir(run.root)).toBe(true);
    expect(fs.existsSync(run.root)).toBe(false);
  });

  test('removeRunDir refuses directories without our sentinel', () => {
    const plain = path.join(dir, 'testforge-run-plain');
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'keep.txt'), 'x');
    expect(removeRunDir(plain)).toBe(false);
    expect(fs.existsSync(path.join(plain, 'keep.txt'))).toBe(true);
  });

  test('removeRunDir refuses a sentinel with the wrong owner', () => {
    const d = path.join(dir, 'testforge-run-other');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, SENTINEL), JSON.stringify({ owner: 'someone-else' }));
    expect(removeRunDir(d)).toBe(false);
    expect(fs.existsSync(d)).toBe(true);
  });

  test('removeRunDir refuses a copied sentinel in a directory without our prefix', () => {
    const d = path.join(dir, 'project');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, SENTINEL), JSON.stringify({ owner: 'testforge', runId: 'x', created: 0 }));
    expect(removeRunDir(d)).toBe(false);
    expect(fs.existsSync(d)).toBe(true);
  });

  test('removeRunDir refuses unreadable/garbage sentinels', () => {
    const d = path.join(dir, 'testforge-run-garbage');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, SENTINEL), 'not json');
    expect(removeRunDir(d)).toBe(false);
  });
});

describe('cleanupStale', () => {
  test('removes only owned directories older than the limit', () => {
    const old = createRunDir('old', dir);
    const fresh = createRunDir('fresh', dir);
    fs.writeFileSync(path.join(old.root, SENTINEL), JSON.stringify({ owner: 'testforge', runId: 'old', created: Date.now() - 2 * 24 * 3600_000 }));
    const unowned = path.join(dir, 'testforge-run-unowned');
    fs.mkdirSync(unowned);
    const unrelated = path.join(dir, 'something-else');
    fs.mkdirSync(unrelated);
    fs.writeFileSync(path.join(unrelated, SENTINEL), JSON.stringify({ owner: 'testforge', created: 0 }));

    expect(cleanupStale(dir)).toBe(1);
    expect(fs.existsSync(old.root)).toBe(false);
    expect(fs.existsSync(fresh.root)).toBe(true);
    expect(fs.existsSync(unowned)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  test('a custom max age applies', () => {
    const run = createRunDir('r', dir);
    fs.writeFileSync(path.join(run.root, SENTINEL), JSON.stringify({ owner: 'testforge', runId: 'r', created: Date.now() - 10_000 }));
    expect(cleanupStale(dir, 60_000)).toBe(0);
    expect(cleanupStale(dir, 1_000)).toBe(1);
  });
});

describe('execution copies', () => {
  test('copies files, links node_modules and writes our configs', () => {
    const project = path.join(dir, 'proj');
    fs.mkdirSync(path.join(project, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(project, 'package.json'), '{"type":"module"}');
    const run = createRunDir('c', dir);
    const copy = createCopy(run, 'original', project, [{ rel: 'src/a.ts', text: 'export const a = 1;\n' }, { rel: 'src/a.test.ts', text: '' }], ['src/a.test.ts']);
    expect(fs.readFileSync(path.join(copy, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(fs.lstatSync(path.join(copy, 'node_modules')).isSymbolicLink()).toBe(true);
    const tsconfig = JSON.parse(fs.readFileSync(path.join(copy, 'tsconfig.testforge.json'), 'utf8'));
    expect(tsconfig.files).toEqual(['src/a.ts', 'src/a.test.ts']);
    expect(fs.readFileSync(path.join(copy, 'vitest.testforge.config.mjs'), 'utf8')).toContain('"allowOnly": false');
    expect(() => writeFile(copy, '../escape.ts', 'x')).toThrow(TestForgeError);
    expect(() => createCopy(run, 'evil', project, [{ rel: '../../x.ts', text: '' }], [])).toThrow(/escapes the run directory/);
    expect(removeRunDir(run.root)).toBe(true);
    expect(fs.existsSync(path.join(project, 'node_modules'))).toBe(true); // the link was removed, not its target
  });
});
