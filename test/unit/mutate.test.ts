import { describe, expect, test } from 'vitest';
import { findExports, parse } from '../../src/analysis/analyze';
import type { MutationOutcome, MutationRecord, SuiteRun, TestResult } from '../../src/core/types';
import { applyMutation, classify, compare, enumerateMutations, score } from '../../src/mutation/mutate';

const SOURCE = `// a >= b in a comment
export function other(x: number): boolean {
  return x >= 1;
}

/** doc: a < b and a === b */
export function target(a: number, b: number, s: string): boolean {
  const note = "a >= b and a !== b";
  const t = \`x <= y \${a > b}\`;
  type Pair = [number, number];
  const pair: Pair = [a, b];
  const inner = (x: number) => x < 0;
  function nested(): boolean {
    return x === 1 || true;
  }
  const obj = { m() { return a <= b; }, get g() { return a >= b; } };
  if (a >= b && a !== 0) {
    return true;
  }
  // return false if a < b
  if (s === 'x') return false;
  return pair[0] < pair[1];
}

export const arrow = (n: number): boolean => n <= 3;
export const alwaysTrue = (): boolean => true;
`;

const sf = parse('src/m.ts', SOURCE);
const exp = (name: string) => findExports(sf).find((e) => e.name === name)!;
const muts = (name: string) => enumerateMutations(sf, exp(name).node, 'src/m.ts', 'hash1');

describe('enumerateMutations', () => {
  test('finds only operators in the target body, skipping comments, strings, types and nested functions', () => {
    const m = muts('target');
    expect(m.map((x) => [x.family, x.original, x.replacement, x.line])).toEqual([
      ['relational-boundary', '>', '>=', 9], // inside the template substitution: real code
      ['relational-boundary', '>=', '>', 17],
      ['strict-equality', '!==', '===', 17],
      ['boolean-return', 'true', 'false', 18],
      ['strict-equality', '===', '!==', 21],
      ['boolean-return', 'false', 'true', 21],
      ['relational-boundary', '<', '<=', 22],
    ]);
    const bodyStart = exp('target').bodyStart;
    const bodyEnd = exp('target').bodyEnd;
    for (const x of m) {
      expect(x.start).toBeGreaterThanOrEqual(bodyStart);
      expect(x.end).toBeLessThanOrEqual(bodyEnd);
      expect(SOURCE.slice(x.start, x.end)).toBe(x.original);
    }
  });

  test('handles expression-bodied arrows', () => {
    expect(muts('arrow').map((x) => `${x.original}->${x.replacement}`)).toEqual(['<=-><']);
    expect(muts('alwaysTrue').map((x) => `${x.original}->${x.replacement}`)).toEqual(['true->false']);
  });

  test('does not touch other functions in the file', () => {
    const m = muts('target');
    const otherBody = exp('other');
    expect(m.every((x) => x.start > otherBody.bodyEnd)).toBe(true);
  });

  test('IDs are deterministic and depend on the file hash and position', () => {
    const a = muts('target');
    const b = muts('target');
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
    expect(new Set(a.map((x) => x.id)).size).toBe(a.length);
    for (const x of a) expect(x.id).toMatch(/^m-[0-9a-f]{10}$/);
    const c = enumerateMutations(sf, exp('target').node, 'src/m.ts', 'hash2');
    expect(c[0].id).not.toBe(a[0].id);
  });

  test('sorted by position', () => {
    const m = muts('target');
    expect(m.map((x) => x.start)).toEqual([...m.map((x) => x.start)].sort((p, q) => p - q));
  });
});

describe('applyMutation', () => {
  test('replaces exactly the token', () => {
    const m = muts('target').find((x) => x.original === '>=')!;
    const out = applyMutation(SOURCE, m);
    expect(out.length).toBe(SOURCE.length - 1);
    expect(out).toContain('if (a > b && a !== 0)');
    expect(out.replace('if (a > b && a !== 0)', '')).toBe(SOURCE.replace('if (a >= b && a !== 0)', ''));
  });

  test('refuses when the original token is not at the recorded position', () => {
    const m = muts('target')[1];
    expect(() => applyMutation(' ' + SOURCE, m)).toThrow(/original token not found/);
    expect(() => applyMutation(SOURCE.replace('a >= b &&', 'a == b &&'), m)).toThrow(/original token not found/);
  });
});

const t = (file: string, title: string, status: TestResult['status'], timedOut = false): TestResult => ({ file, title, status, timedOut });
const ids = (...xs: string[]) => new Set(xs);

describe('classify', () => {
  const suite = ids('a.test.ts::one', 'a.test.ts::two');
  const run = (status: SuiteRun['status'], tests: TestResult[]): SuiteRun => ({ status, tests });

  test('killed when a suite test fails, with the detecting titles', () => {
    expect(classify(run('completed', [t('a.test.ts', 'one', 'failed'), t('a.test.ts', 'two', 'passed')]), suite)).toEqual({ outcome: 'killed', detecting: ['one'] });
  });
  test('survived when all suite tests pass, ignoring other suites', () => {
    expect(classify(run('completed', [t('a.test.ts', 'one', 'passed'), t('a.test.ts', 'two', 'passed'), t('b.test.ts', 'x', 'failed')]), suite).outcome).toBe('survived');
  });
  test('timeouts are timeouts, not kills', () => {
    expect(classify(run('completed', [t('a.test.ts', 'one', 'failed', true), t('a.test.ts', 'two', 'failed')]), suite).outcome).toBe('timeout');
    expect(classify(run('timeout', []), suite).outcome).toBe('timeout');
  });
  test('errors and cancellations are excluded', () => {
    expect(classify({ status: 'error', tests: [], error: 'boom' }, suite)).toMatchObject({ outcome: 'error', note: 'boom' });
    expect(classify(run('cancelled', []), suite).outcome).toBe('not-run');
  });
  test('duplicate test titles in one file still classify as killed or survived', () => {
    const dupSuite = ids('a.test.ts::same', 'a.test.ts::other');
    const tests = (s1: TestResult['status'], s2: TestResult['status']) => [t('a.test.ts', 'same', s1), t('a.test.ts', 'same', s2), t('a.test.ts', 'other', 'passed')];
    expect(classify(run('completed', tests('passed', 'passed')), dupSuite).outcome).toBe('survived');
    expect(classify(run('completed', tests('passed', 'failed')), dupSuite)).toEqual({ outcome: 'killed', detecting: ['same'] });
    expect(classify(run('completed', [t('a.test.ts', 'same', 'passed'), t('a.test.ts', 'same', 'passed')]), dupSuite).outcome).toBe('error');
  });

  test('missing test identities are an error, not a kill', () => {
    expect(classify(run('completed', [t('a.test.ts', 'one', 'failed')]), suite).outcome).toBe('error');
  });
});

describe('score and compare', () => {
  test('timeouts, errors, invalid and not-run are excluded from the rate', () => {
    const s = score(['killed', 'survived', 'survived', 'timeout', 'error', 'invalid', 'not-run', undefined]);
    expect(s).toEqual({ killed: 1, survived: 2, excluded: 4, rate: 1 / 3 });
  });
  test('zero denominator gives null (N/A)', () => {
    expect(score([]).rate).toBeNull();
    expect(score(['timeout', 'invalid']).rate).toBeNull();
    expect(score(['timeout', 'invalid']).excluded).toBe(2);
  });
  test('comparison uses only mutations valid for both suites', () => {
    const rec = (baseline: MutationOutcome | undefined, generated: MutationOutcome): MutationRecord => ({
      id: 'm',
      family: 'relational-boundary',
      file: 'f',
      start: 0,
      end: 1,
      line: 1,
      column: 1,
      original: '>',
      replacement: '>=',
      baseline,
      generated,
      detectingTests: [],
    });
    const c = compare([rec('survived', 'killed'), rec('killed', 'killed'), rec('survived', 'survived'), rec('timeout', 'killed'), rec('killed', 'error'), rec(undefined, 'killed')]);
    expect(c).toEqual({ denominator: 3, before: 1, after: 2, excluded: 3 });
    expect(compare([]).denominator).toBe(0);
  });
});
