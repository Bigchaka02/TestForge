import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import type { CaseRecord, MutationOutcome, MutationRecord, RunReport } from '../../src/core/types';
import { escapeMarkdown, lineInsights, possibleBugs, scoreSummary, targetLine } from '../../src/report/insights';

const FIXTURE = path.resolve(__dirname, '../../fixtures/sample/src');

function report(over: Partial<RunReport> = {}): RunReport {
  return { runId: 'r1', demo: false, exportName: 'isEligible', sourceFile: 'src/age.ts', contextFiles: ['src/age.ts', 'src/age.test.ts'], cases: [], mutations: [], scores: {}, ...over } as RunReport;
}

const mut = (line: number, original: string, replacement: string, baseline?: MutationOutcome, generated?: MutationOutcome, detectingTests: string[] = []): MutationRecord => ({
  id: `m-${line}-${original}-${replacement}`,
  family: 'relational-boundary',
  file: 'src/age.ts',
  start: 0,
  end: 0,
  line,
  column: 1,
  original,
  replacement,
  baseline,
  generated,
  detectingTests,
});

// The isEligible run from the integration test: the existing tests (17, 25) only catch 18 -> 17.
const AGE = [
  mut(3, '>=', '>', 'survived', 'killed', ['[tf-1] age 18 is eligible (boundary)']),
  mut(3, '18', '17', 'killed', 'killed', ['age 17 is not eligible']),
  mut(3, '18', '19', 'survived', 'killed', ['[tf-1] age 18 is eligible (boundary)']),
];

describe('lineInsights', () => {
  test('a line is protected when the final suite detects every valid mutation on it', () => {
    const [l, ...rest] = lineInsights(report({ mutations: AGE }));
    expect(rest).toEqual([]);
    expect(l).toMatchObject({ line: 3, state: 'protected' });
    expect(l.hover).toContain('**TestForge** · protected: every checked change on this line is detected with the generated tests\n');
    expect(l.hover).toContain('- `>=` → `>`: existing tests MISSED · with generated tests DETECTED\n  - detected by "\\[tf\\-1\\] age 18 is eligible \\(boundary\\)"');
    expect(l.hover).toContain('- `18` → `17`: existing tests DETECTED · with generated tests DETECTED\n  - detected by "age 17 is not eligible"');
    expect(l.hover).not.toContain('DEMO');
  });

  test('a line is exposed when one valid mutation survives the final suite', () => {
    const [l] = lineInsights(report({ mutations: [mut(10, 'value <= MIN', 'true', undefined, 'killed', ['t']), mut(10, '<=', '<', undefined, 'survived'), mut(10, 'value <= MIN', 'false', undefined, 'invalid')] }));
    expect(l).toMatchObject({ line: 10, state: 'exposed' });
    expect(l.hover).toContain('exposed: 1 of 2 checked changes on this line go undetected even with the generated tests\n');
    expect(l.hover).toContain('- `<=` → `<`: with generated tests MISSED\n');
    expect(l.hover).toContain('- `value <= MIN` → `false`: with generated tests INVALID\n');
    expect(l.hover).not.toContain('existing tests');
  });

  test('baseline-only reports are judged by the existing tests', () => {
    const audit = AGE.map(({ generated: _g, ...m }) => ({ ...m, detectingTests: m.baseline === 'killed' ? m.detectingTests : [] }));
    const [l] = lineInsights(report({ mutations: audit, demo: true }));
    expect(l).toMatchObject({ line: 3, state: 'exposed' });
    expect(l.hover).toContain('**TestForge** (DEMO) · exposed: 2 of 3 checked changes on this line go undetected by the existing tests\n');
    expect(l.hover).toContain('- `>=` → `>`: existing tests MISSED\n');
    expect(l.hover).not.toContain('with generated tests');
  });

  test('lines without a valid mutation and mutations of other files get no marker', () => {
    const other = { ...mut(1, '<', '<=', undefined, 'survived'), file: 'src/limits.ts' };
    const lines = lineInsights(report({ mutations: [mut(9, 'a', 'b', 'not-run', 'not-run'), mut(4, 'x', 'y', undefined, 'timeout'), mut(4, '!', '', undefined, 'error'), other, mut(2, '===', '!==', undefined, 'invalid'), ...AGE] }));
    expect(lines.map((l) => l.line)).toEqual([3]);
  });

  test('lines come in source order; an empty replacement reads "(removed)"', () => {
    const lines = lineInsights(report({ mutations: [mut(7, 'true', 'false', undefined, 'survived'), mut(5, '!', '', undefined, 'killed', ['t'])] }));
    expect(lines.map((l) => [l.line, l.state])).toEqual([
      [5, 'protected'],
      [7, 'exposed'],
    ]);
    expect(lines[0].hover).toContain('- `!` → (removed): with generated tests DETECTED');
  });

  test('lists at most three detecting tests', () => {
    const [l] = lineInsights(report({ mutations: [mut(3, '>=', '>', undefined, 'killed', ['a', 'b', 'c', 'd', 'e'])] }));
    expect(l.hover).toContain('detected by "a", "b", "c" and 2 more');
  });

  test('escapes titles and source tokens from the report', () => {
    const title = '[x](https://evil.example) <img src=x onerror=alert(1)> **b** `c`\n\n# h &lt; \u202Ecba';
    const [l] = lineInsights(report({ runId: 'r_1', mutations: [mut(3, 'a `b`\n\n# not a heading', '`', undefined, 'killed', [title])] }));
    expect(l.hover).toContain('detected by "\\[x\\]\\(https\\:\\/\\/evil\\.example\\) \\<img src\\=x onerror\\=alert\\(1\\)\\> \\*\\*b\\*\\* \\`c\\` \\# h \\&lt\\; cba"');
    expect(l.hover).toContain('- ``a `b` # not a heading`` → `` ` ``: with generated tests DETECTED');
    expect(l.hover).toContain('(run r\\_1)');
    expect(l.hover).not.toMatch(/[^\\]<|\]\(|\u202E|\n#/);
  });
});

describe('escapeMarkdown', () => {
  test('escapes every ASCII punctuation character and keeps text on one line', () => {
    expect(escapeMarkdown('*a* [b](c) <d> \\ & `e` _f_\r\n\tg')).toBe('\\*a\\* \\[b\\]\\(c\\) \\<d\\> \\\\ \\& \\`e\\` \\_f\\_ g');
    expect(escapeMarkdown('plain text 42')).toBe('plain text 42');
  });
});

describe('scoreSummary', () => {
  test('uses the shared comparison when there are existing tests', () => {
    const scores = { baseline: { killed: 1, survived: 2, excluded: 0, rate: 1 / 3 }, generated: { killed: 3, survived: 0, excluded: 0, rate: 1 }, comparison: { denominator: 3, before: 1, after: 3, excluded: 0 } };
    expect(scoreSummary(report({ scores }))).toBe('TestForge: existing tests catch 1/3 changes → 3/3 with generated tests');
    expect(scoreSummary(report({ scores, demo: true }))).toBe('TestForge: existing tests catch 1/3 changes → 3/3 with generated tests (DEMO)');
  });

  test('without existing tests, and for baseline-only reports', () => {
    expect(scoreSummary(report({ scores: { generated: { killed: 7, survived: 1, excluded: 0, rate: 7 / 8 } } }))).toBe('TestForge: tests catch 7/8 changes with generated tests');
    expect(scoreSummary(report({ scores: { baseline: { killed: 2, survived: 2, excluded: 1, rate: 0.5 } } }))).toBe('TestForge: tests catch 2/4 changes');
  });

  test('is undefined when nothing was scored', () => {
    expect(scoreSummary(report())).toBeUndefined();
    expect(scoreSummary(report({ scores: { generated: { killed: 0, survived: 0, excluded: 3, rate: null } } }))).toBeUndefined();
    const none = { killed: 0, survived: 0, excluded: 2, rate: null };
    expect(scoreSummary(report({ scores: { baseline: none, generated: none, comparison: { denominator: 0, before: 0, after: 0, excluded: 2 } } }))).toBeUndefined();
  });
});

describe('possibleBugs', () => {
  const evidence = (fileId: string, line: number, excerpt: string) => [{ fileId, startLine: line, endLine: line, excerpt }];
  const kase = (over: Partial<CaseRecord>): CaseRecord =>
    ({ id: 'tf-1', title: 'member order of exactly 100 costs 90', basis: 'documented', status: 'accepted', originalOutcome: 'failed', evidence: evidence('F1', 3, 'Requirement: an order of exactly 100 by a member costs 90.'), failureMessage: 'AssertionError: expected 100 to strictly equal 90\n    at src/discount.testforge.r1.test.ts:14:54', ...over }) as CaseRecord;
  const discount = (cases: CaseRecord[], over: Partial<RunReport> = {}) => report({ exportName: 'finalPrice', sourceFile: 'src/discount.ts', contextFiles: ['src/discount.ts', 'src/discount.test.ts'], cases, ...over });

  test('a documented case that fails against the code is a possible bug', () => {
    expect(possibleBugs(discount([kase({})]))).toEqual([
      {
        caseId: 'tf-1',
        message: 'Possible bug: "member order of exactly 100 costs 90" is documented (src/discount.ts:3) but fails against the code: AssertionError: expected 100 to strictly equal 90',
        evidence: { file: 'src/discount.ts', line: 3, excerpt: 'Requirement: an order of exactly 100 by a member costs 90.' },
      },
    ]);
    expect(possibleBugs(discount([kase({})], { demo: true }))[0].message).toMatch(/^Possible bug \(DEMO\): /);
  });

  test('an existing-test case cites the test file', () => {
    const [b] = possibleBugs(discount([kase({ basis: 'existing-test', evidence: evidence('F2', 4, "finalPrice(200, false)"), failureMessage: '\n\nError: boom\nstack' })]));
    expect(b.message).toBe('Possible bug: "member order of exactly 100 costs 90" follows from an existing test (src/discount.test.ts:4) but fails against the code: Error: boom');
    expect(b.evidence).toEqual({ file: 'src/discount.test.ts', line: 4, excerpt: 'finalPrice(200, false)' });
  });

  test('inferred, passing, timed-out and rejected cases are not reported', () => {
    const cases = [kase({ basis: 'inferred', evidence: [] }), kase({ originalOutcome: 'passed' }), kase({ originalOutcome: 'timeout' }), kase({ status: 'rejected', round: 'improvement' }), kase({ originalOutcome: undefined })];
    expect(possibleBugs(discount(cases))).toEqual([]);
  });

  test('an unknown evidence file or a missing failure message still gives a readable warning', () => {
    const [b] = possibleBugs(discount([kase({ title: 'two\nlines', evidence: evidence('F9', 1, 'x'), failureMessage: undefined })]));
    expect(b).toEqual({ caseId: 'tf-1', message: 'Possible bug: "two lines" is documented but fails against the code.', evidence: undefined });
  });
});

describe('targetLine', () => {
  test('finds the declaration line of the target function', () => {
    expect(targetLine(report({ exportName: 'finalPrice', sourceFile: 'src/discount.ts' }), fs.readFileSync(path.join(FIXTURE, 'discount.ts'), 'utf8'))).toBe(5);
    expect(targetLine(report({ exportName: 'clamp', sourceFile: 'src/clamp.ts' }), fs.readFileSync(path.join(FIXTURE, 'clamp.ts'), 'utf8'))).toBe(6);
    expect(targetLine(report(), 'export function other(): void {}\n')).toBeUndefined();
  });
});
