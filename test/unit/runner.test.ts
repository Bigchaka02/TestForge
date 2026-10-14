import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { childEnv, parseVitestReport } from '../../src/execution/runner';

const COPY = '/tmp/copy';
// Like Vitest, a file is "failed" when one of its tests failed, unless the caller says otherwise.
const file = (name: string, results: { title: string; status: string; failureMessages?: string[] }[], message?: string, status?: string) => ({
  name: `${COPY}/${name}`,
  status: status ?? (results.some((r) => r.status === 'failed') ? 'failed' : 'passed'),
  message,
  assertionResults: results.map((r) => ({ title: r.title, fullName: r.title, status: r.status, failureMessages: r.failureMessages ?? [], ancestorTitles: [] })),
});
const report = (...files: unknown[]) => JSON.stringify({ numTotalTests: 0, testResults: files });

describe('parseVitestReport', () => {
  test('parses per-test results with posix paths relative to the copy', () => {
    const r = parseVitestReport(report(file('src/a.test.ts', [{ title: 'one', status: 'passed' }, { title: 'two', status: 'failed', failureMessages: ['expected 1'] }])), COPY, ['src/a.test.ts']);
    expect(r).toEqual({
      status: 'completed',
      tests: [
        { file: 'src/a.test.ts', title: 'one', status: 'passed', timedOut: false, message: undefined },
        { file: 'src/a.test.ts', title: 'two', status: 'failed', timedOut: false, message: 'expected 1' },
      ],
    });
  });
  test('marks per-test timeouts', () => {
    const r = parseVitestReport(report(file('a.test.ts', [{ title: 't', status: 'failed', failureMessages: ['Error: Test timed out in 2000ms.'] }])), COPY, ['a.test.ts']);
    expect(r.status).toBe('timeout');
    expect(r.tests[0].timedOut).toBe(true);
  });
  test('missing files, empty files and bad JSON are errors', () => {
    expect(parseVitestReport(report(), COPY, ['a.test.ts']).error).toMatch(/missing from the report/);
    expect(parseVitestReport(report(file('a.test.ts', [], 'SyntaxError')), COPY, ['a.test.ts']).error).toMatch(/SyntaxError/);
    expect(parseVitestReport('{', COPY, []).status).toBe('error');
    expect(parseVitestReport('{}', COPY, []).status).toBe('error');
  });
  test('skipped and todo tests are kept as skipped; the run still completes', () => {
    const r = parseVitestReport(report(file('a.test.ts', [{ title: 'one', status: 'passed' }, { title: 'two', status: 'skipped' }, { title: 'three', status: 'todo' }])), COPY, ['a.test.ts']);
    expect(r.status).toBe('completed');
    expect(r.tests.map((t) => [t.title, t.status])).toEqual([
      ['one', 'passed'],
      ['two', 'skipped'],
      ['three', 'skipped'],
    ]);
  });
  test('a failed file without a failed test (a hook failed) is an error', () => {
    // beforeAll threw: Vitest marks the file failed and its tests skipped.
    const before = parseVitestReport(report(file('a.test.ts', [{ title: 't', status: 'skipped' }], 'hook boom', 'failed')), COPY, ['a.test.ts']);
    expect(before).toMatchObject({ status: 'error', error: 'a.test.ts: hook boom' });
    // afterAll in a nested describe threw: tests passed, the file failed, and there is no file-level message.
    const after = parseVitestReport(report(file('a.test.ts', [{ title: 't', status: 'passed' }], '', 'failed')), COPY, ['a.test.ts']);
    expect(after).toMatchObject({ status: 'error', error: 'a.test.ts: a hook failed outside any test' });
    // A failing test explains the failed file: no extra error.
    expect(parseVitestReport(report(file('a.test.ts', [{ title: 't', status: 'failed' }], '', 'failed')), COPY, ['a.test.ts']).status).toBe('completed');
  });
});

describe('parseVitestReport path aliases', () => {
  // Windows can name the same directory by an 8.3 short path and a long path; a symlink
  // reproduces the "two names, one directory" situation on every platform.
  test.skipIf(process.platform === 'win32')('maps report paths through real paths when the copy path is an alias', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'testforge-unit-alias-'));
    const alias = `${real}-link`;
    try {
      fs.mkdirSync(path.join(real, 'src'));
      fs.writeFileSync(path.join(real, 'src/a.test.ts'), '');
      fs.symlinkSync(real, alias);
      const json = JSON.stringify({ numTotalTests: 1, testResults: [{ name: path.join(fs.realpathSync.native(real), 'src/a.test.ts'), status: 'passed', assertionResults: [{ title: 't', fullName: 't', status: 'passed', failureMessages: [], ancestorTitles: [] }] }] });
      const r = parseVitestReport(json, alias, ['src/a.test.ts']);
      expect(r.status).toBe('completed');
      expect(r.tests[0].file).toBe('src/a.test.ts');
    } finally {
      fs.rmSync(alias, { force: true });
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
});

describe('childEnv', () => {
  test('passes only a fixed allowlist plus deterministic settings', () => {
    process.env.TESTFORGE_SECRET_PROBE = 'x';
    process.env.NODE_OPTIONS = '--require /evil.js';
    const env = childEnv('/tmp/x');
    delete process.env.TESTFORGE_SECRET_PROBE;
    delete process.env.NODE_OPTIONS;
    expect(env.TESTFORGE_SECRET_PROBE).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env).toMatchObject({ TMPDIR: '/tmp/x', CI: '1', TZ: 'UTC' });
  });
});
