import { describe, expect, test } from 'vitest';
import type { CaseRecord, MutationRecord, RunReport } from '../../src/core/types';
import { mdCode, mdText, proofMarkdown } from '../../src/report/markdown';

const mutation = (line: number, original: string, replacement: string, baseline: MutationRecord['baseline'], generated: MutationRecord['generated']): MutationRecord => ({
  id: `m-${line}${replacement}`,
  family: 'relational-boundary',
  file: 'src/age.ts',
  start: 0,
  end: 1,
  line,
  column: 1,
  original,
  replacement,
  baseline,
  generated,
  detectingTests: [],
});

const kase = (title: string, over: Partial<CaseRecord> = {}): CaseRecord =>
  ({ title, category: 'boundary', args: [], expectation: { kind: 'returns', value: 1 }, basis: 'documented', evidence: [], rationale: '', id: 'tf-1', fingerprint: 'f', status: 'accepted', originalOutcome: 'passed', ...over }) as CaseRecord;

function report(over: Partial<RunReport> = {}): RunReport {
  return {
    schemaVersion: 1,
    runId: 'run1',
    status: 'completed',
    stage: 'completed',
    demo: false,
    scope: 'selected-module test scope',
    exportName: 'isEligible',
    sourceFile: 'src/age.ts',
    inputHashes: {},
    model: 'copilot/gpt (GPT)',
    toolVersions: {},
    startedAt: '2026-10-11T19:00:00.000Z',
    stageMs: {},
    contextFiles: ['src/age.ts'],
    contextExclusions: [],
    baselineTests: ['src/age.test.ts'],
    cases: [kase('age 18 is eligible')],
    duplicatesSkipped: 0,
    unresolvedQuestions: [],
    baselineRuns: [],
    candidateRuns: [],
    mutations: [mutation(3, '>=', '>', 'survived', 'killed'), mutation(3, '18', '17', 'killed', 'killed'), mutation(3, '18', '19', 'survived', 'killed')],
    scores: {
      baseline: { killed: 1, survived: 2, excluded: 0, rate: 1 / 3 },
      generated: { killed: 3, survived: 0, excluded: 0, rate: 1 },
      comparison: { denominator: 3, before: 1, after: 3, excluded: 0 },
    },
    modelRequests: 1,
    limitations: [],
    cleanup: 'done',
    ...over,
  };
}

describe('proofMarkdown', () => {
  test('summarizes the before/after numbers from the report', () => {
    const md = proofMarkdown(report());
    expect(md).toContain('### TestForge proof: `isEligible` in `src/age.ts`');
    expect(md).toContain('| Existing tests | 1 / 3 |');
    expect(md).toContain('| With TestForge tests | 3 / 3 |');
    expect(md).toContain('On the same 3 mutation(s): **1 → 3** detected.');
    expect(md).toContain('| 3 | `>=` → `>` | **missed** | detected |');
    expect(md).toContain('Cases: 1 accepted (1 backed by docs or existing tests, 0 inferred), 0 failing');
    expect(md).not.toContain('DEMO');
    expect(md).not.toContain('Possible bugs');
  });

  test('labels demo runs and lists documented cases that fail as possible bugs', () => {
    const bug = kase('member order of exactly 100 costs 90', { originalOutcome: 'failed', failureMessage: 'expected 100 to be 90\n  at line 3' });
    const inferredFail = kase('guess', { basis: 'inferred', originalOutcome: 'failed' });
    const md = proofMarkdown(report({ demo: true, status: 'partial', cases: [bug, inferredFail], mutations: [], scores: {} }));
    expect(md).toContain('> DEMO run');
    expect(md).toContain('**Possible bugs**');
    expect(md).toContain('- member order of exactly 100 costs 90: expected 100 to be 90');
    expect(md).not.toContain('- guess');
  });

  test('baseline-only (audit) reports show only the existing-tests column', () => {
    const md = proofMarkdown(report({ cases: [], scores: { baseline: { killed: 1, survived: 2, excluded: 0, rate: 1 / 3 } }, mutations: [mutation(3, '>=', '>', 'survived', undefined)] }));
    expect(md).toContain('| Existing tests | 1 / 3 |');
    expect(md).not.toContain('With TestForge tests');
    expect(md).toContain('| 3 | `>=` → `>` | **missed** |');
    expect(md).not.toContain('Cases:');
  });

  test('stale runs say so, with escaped reasons', () => {
    const md = proofMarkdown(report(), ['src/age.ts changed', 'new test file src/a_b.test.ts']);
    expect(md).toContain('> STALE: src/age.ts changed; new test file src/a\\_b.test.ts. These results may not match the current code.');
    expect(proofMarkdown(report())).not.toContain('STALE');
  });

  test('failed runs say why and show no scores', () => {
    const md = proofMarkdown(report({ status: 'failed', failure: { kind: 'baseline-failure', message: 'Pre-existing test failure: x' }, mutations: [], scores: {} }));
    expect(md).toContain('Run ended **FAILED**: Pre-existing test failure: x');
    expect(md).not.toContain('| Suite |');
  });

  test('untrusted text cannot inject HTML, links or break tables', () => {
    const hostile = kase('<img src=x onerror=alert(1)> [click](http://evil) | col', { originalOutcome: 'failed', failureMessage: '</details><script>x</script>' });
    const md = proofMarkdown(report({ cases: [hostile], mutations: [mutation(4, 'a || b', 'a && b', 'survived', 'killed')] }));
    expect(md).not.toMatch(/(^|[^\\])<(img|script|\/details><script)/m);
    expect(md).toContain('\\<img src=x onerror=alert(1)\\> \\[click\\](http://evil) \\| col');
    expect(md).toContain('| 4 | `a \\|\\| b` → `a && b` |');
  });
});

describe('helpers', () => {
  test('mdCode handles backticks, pipes, newlines and empty replacements', () => {
    expect(mdCode('a `b` c')).toBe('``a `b` c``');
    expect(mdCode('`x`')).toBe('`` `x` ``');
    expect(mdCode('a|b')).toBe('`a\\|b`');
    expect(mdCode('a\nb')).toBe('`a b`');
    expect(mdCode('')).toBe('(removed)');
  });

  test('mdText is one escaped line', () => {
    expect(mdText('a\nb*c_')).toBe('a b\\*c\\_');
    expect(mdText('x'.repeat(300), 10)).toBe('x'.repeat(10));
  });

  test('hidden and bidi characters cannot reorder text', () => {
    expect(mdText('a\u202eb\u2066\u200bc')).toBe('a b c');
    expect(mdCode('x\u2028y\u202dz')).toBe('`x y z`');
  });
});
