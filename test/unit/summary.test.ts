import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import type { CaseRecord, MutationRecord, RunReport } from '../../src/core/types';
import { summarize } from '../../src/ui/summary';

function report(over: Partial<RunReport> = {}): RunReport {
  return {
    runId: 'r1',
    status: 'completed',
    exportName: 'isEligible',
    sourceFile: 'src/age.ts',
    model: 'Fake',
    baselineTests: [],
    cases: [],
    mutations: [],
    scores: {},
    limitations: [],
    ...over,
  } as RunReport;
}

const mutation = (original: string, replacement: string, over: Partial<MutationRecord>): MutationRecord =>
  ({ id: `${original}->${replacement}`, line: 2, original, replacement, detectingTests: [], ...over }) as MutationRecord;

const accepted = (title: string, originalOutcome: CaseRecord['originalOutcome'], over: Partial<CaseRecord> = {}) => ({ status: 'accepted', title, originalOutcome, basis: 'inferred', ...over }) as CaseRecord;

describe('chat tool summary', () => {
  test('a generate run lists its cases, scores and survivors, and says nothing was applied', () => {
    const text = summarize(
      report({
        mode: 'generate',
        model: 'GPT (Copilot)',
        cases: [
          accepted('accepts 18', 'passed', { basis: 'documented' }),
          accepted('rejects 17', 'failed', { failureMessage: 'expected true to be false\n    at src/age.testforge.r1.test.ts:9:1' }),
          { status: 'rejected', title: 'calls a helper' } as CaseRecord,
        ],
        mutations: [
          mutation('>=', '>', { baseline: 'survived', generated: 'killed', detectingTests: ['accepts 18'] }),
          mutation('18', '19', { baseline: 'survived', generated: 'survived' }),
          mutation('!x', 'x', { baseline: 'invalid', generated: 'invalid', note: 'does not type-check' }),
        ],
        scores: {
          baseline: { killed: 0, survived: 2, excluded: 1, rate: 0 },
          generated: { killed: 1, survived: 1, excluded: 1, rate: 0.5 },
          comparison: { denominator: 2, before: 0, after: 1, excluded: 1 },
        },
        improvement: { survivorsBefore: 2, proposed: 2, added: 1, killed: 1 },
        generatedTest: '// generated\n',
        generatedTestPath: 'src/age.testforge.r1.test.ts',
      }),
    );
    expect(text.split('\n')[0]).toBe('TestForge Generate & Verify of isEligible in src/age.ts: COMPLETED. Model: GPT (Copilot).');
    expect(text).toContain('- PASS: accepts 18 [documented]\n- FAIL: rejects 17 [inferred] (expected true to be false)\n');
    expect(text).toContain('1 other proposed case(s) were rejected or duplicates');
    expect(text).toContain('Mutation score of the existing tests: 0/2 detected, 1 excluded.');
    expect(text).toContain('Mutation score with the generated tests: 1/2 detected, 1 excluded.');
    expect(text).toContain('Before/after on the same 2 mutation(s): 0/2 → 1/2 (+1).');
    expect(text).toContain('Improvement pass: 1/2 missed change(s) now detected (1 case(s) added of 2 proposed).');
    // Scored on the generated suite: the mutation it detects is not a survivor.
    expect(text).toContain('Surviving mutations (no test fails when the code is changed this way):\n- line 2: 18 → 19\n');
    expect(text).not.toContain('>= → >');
    expect(text).toContain('Not scored:\n- line 2: !x → x: INVALID (does not type-check)');
    expect(text).toContain('The generated tests are NOT applied: nothing was written to the workspace.');
    expect(text).toContain('create src/age.testforge.r1.test.ts with the command "TestForge: Apply Tests" ("TestForge: Apply Failing Candidate" keeps failing cases).');
    expect(text).not.toContain('Next step');
  });

  test('an audit scores the existing tests and names the file to add tests to', () => {
    const text = summarize(
      report({
        mode: 'audit',
        model: 'none (audit only)',
        baselineTests: ['test/age.test.ts'],
        mutations: [
          mutation('>=', '>', { baseline: 'survived' }),
          mutation('18', '19', { baseline: 'survived' }),
          mutation('age >= 18', 'true', { baseline: 'killed', detectingTests: ['isEligible > child'] }),
          mutation('age >= 18', 'false', { baseline: 'timeout', note: 'Timed out' }),
        ],
        scores: { baseline: { killed: 1, survived: 2, excluded: 1, rate: 1 / 3 } },
      }),
    );
    expect(text.split('\n')[0]).toBe('TestForge audit of isEligible in src/age.ts: COMPLETED. No AI model was used and no file was changed.');
    expect(text).toContain('Existing tests: test/age.test.ts');
    expect(text).toContain('Mutation score of the existing tests: 1/3 detected, 1 excluded.');
    expect(text).toContain('Surviving mutations (no test fails when the code is changed this way):\n- line 2: >= → >\n- line 2: 18 → 19\n');
    expect(text).toContain('Detected mutations:\n- line 2: age >= 18 → true (by: isEligible > child)');
    expect(text).toContain('Not scored:\n- line 2: age >= 18 → false: TIMEOUT (Timed out)');
    expect(text).toContain('Next step: add test cases to test/age.test.ts that fail under each surviving mutation');
    expect(text).not.toMatch(/Model:|generated tests|NOT applied/);
  });

  test('an audit with no survivors has no next step', () => {
    const text = summarize(report({ mode: 'audit', mutations: [mutation('>=', '>', { baseline: 'killed', detectingTests: ['t'] })], scores: { baseline: { killed: 1, survived: 0, excluded: 0, rate: 1 } } }));
    expect(text).toContain('Mutation score of the existing tests: 1/1 detected.');
    expect(text).not.toMatch(/Surviving|Next step/);
  });

  test('failure details drop Vitest internals and map the temporary copy to project paths', () => {
    const copy = path.join(os.tmpdir(), 'testforge-run-r1-Ab12Cd', 'original');
    const detail = [
      'AssertionError: expected true to be false',
      `    at ${path.join(copy, 'src', 'age.test.ts')}:4:26`,
      `    at file://${path.join(copy, 'node_modules', '@vitest', 'runner', 'dist', 'index.js')}:155:11`,
      '    at node:internal/process/task_queues:105:5',
    ].join('\n');
    const text = summarize(report({ mode: 'audit', status: 'failed', failure: { kind: 'baseline-failure', message: 'An existing test fails.', detail } }));
    expect(text).toContain(`An existing test fails.\nDetails:\nAssertionError: expected true to be false\n    at ${path.join('src', 'age.test.ts')}:4:26`);
    expect(text).not.toMatch(/node_modules|node:internal|testforge-run-/);
  });

  test('a report saved without a mode is a generate run', () => {
    const text = summarize(
      report({
        cases: [accepted('accepts 18', 'passed')],
        mutations: [mutation('>=', '>', { baseline: 'survived', generated: 'survived' })],
        generatedTest: '// generated\n',
        generatedTestPath: 'src/age.testforge.r1.test.ts',
      }),
    );
    expect(text).toMatch(/^TestForge Generate & Verify of isEligible/);
    expect(text).toContain('- line 2: >= → >');
    expect(text).toContain('with the command "TestForge: Apply Tests".');
    expect(text).not.toMatch(/Apply Failing Candidate|Next step/);
  });
});
