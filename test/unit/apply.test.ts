import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { sameResults } from '../../src/core/pipeline';
import type { CaseRecord, RunReport, SuiteRun } from '../../src/core/types';
import { applyGenerated, StoredRun } from '../../src/storage/apply';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'testforge-unit-apply-'));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(base, 'ws-'));
  fs.mkdirSync(path.join(root, 'src'));
});

const passing = { status: 'accepted', originalOutcome: 'passed' } as CaseRecord;

function stored(over: Partial<RunReport> = {}): StoredRun {
  const report = {
    runId: 'r1',
    status: 'completed',
    cases: [passing],
    generatedTestPath: 'src/m.testforge.r1.test.ts',
    generatedTest: '// generated\n',
    ...over,
  } as RunReport;
  return { report, root, savedAt: Date.now() };
}

describe('applyGenerated (A15)', () => {
  test('creates the file once, then reports already-applied', () => {
    const run = stored();
    const first = applyGenerated(run, { allowFailing: false });
    expect(first.kind).toBe('created');
    expect(fs.readFileSync(first.abs, 'utf8')).toBe('// generated\n');
    run.appliedHash = first.hash;
    expect(applyGenerated(run, { allowFailing: false }).kind).toBe('already-applied');
  });

  test('never overwrites an existing file with different content', () => {
    fs.writeFileSync(path.join(root, 'src/m.testforge.r1.test.ts'), 'mine');
    expect(() => applyGenerated(stored(), { allowFailing: false })).toThrow(/never overwrites/);
    expect(fs.readFileSync(path.join(root, 'src/m.testforge.r1.test.ts'), 'utf8')).toBe('mine');
  });

  // Creating symlinks on Windows needs extra privileges.
  test.skipIf(process.platform === 'win32')('refuses to write through a symlink', () => {
    const outside = path.join(base, `outside-${path.basename(root)}.ts`);
    fs.writeFileSync(outside, 'outside');
    fs.symlinkSync(outside, path.join(root, 'src/m.testforge.r1.test.ts'));
    expect(() => applyGenerated(stored(), { allowFailing: false })).toThrow(/symlink/);
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside');
  });

  test('refuses a target folder outside the workspace', () => {
    fs.mkdirSync(path.join(base, `escape-${path.basename(root)}`));
    const run = stored({ generatedTestPath: `../escape-${path.basename(root)}/m.test.ts` });
    expect(() => applyGenerated(run, { allowFailing: false })).toThrow(/outside the workspace/);
  });

  test('a removed file is not silently recreated', () => {
    const run = stored();
    run.appliedHash = applyGenerated(run, { allowFailing: false }).hash;
    fs.rmSync(path.join(root, 'src/m.testforge.r1.test.ts'));
    expect(() => applyGenerated(run, { allowFailing: false })).toThrow(/has since been removed/);
  });

  test('failing cases need allowFailing; failed runs never apply', () => {
    const failing = { status: 'accepted', originalOutcome: 'failed' } as CaseRecord;
    expect(() => applyGenerated(stored({ cases: [failing] }), { allowFailing: false })).toThrow(/Apply Failing Candidate/);
    expect(applyGenerated(stored({ cases: [failing] }), { allowFailing: true }).kind).toBe('created');
    expect(() => applyGenerated(stored({ status: 'failed', failure: { kind: 'infrastructure', message: 'x' } }), { allowFailing: true })).toThrow(/cannot be applied/);
  });
});

describe('repeated-run stability (A08)', () => {
  const run = (...tests: [string, 'passed' | 'failed'][]): SuiteRun => ({
    status: 'completed',
    tests: tests.map(([title, status]) => ({ file: 'a.test.ts', title, status, timedOut: false })),
  });

  test('same outcomes in a different order are stable', () => {
    expect(sameResults(run(['a', 'passed'], ['b', 'failed']), run(['b', 'failed'], ['a', 'passed']))).toBe(true);
  });

  test('a flipped outcome or a missing test is unstable', () => {
    expect(sameResults(run(['a', 'passed']), run(['a', 'failed']))).toBe(false);
    expect(sameResults(run(['a', 'passed'], ['b', 'passed']), run(['a', 'passed']))).toBe(false);
  });
});
