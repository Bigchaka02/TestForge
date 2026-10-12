import { describe, expect, test } from 'vitest';
import type { TargetAnalysis } from '../../src/analysis/analyze';
import { buildPrompt, evidenceFiles, existingTitles } from '../../src/generation/prompt';

const analysis = (tests: string[], over: Partial<TargetAnalysis> = {}) =>
  ({
    exportName: 'f',
    sourceRel: 'src/m.ts',
    target: { isAsync: false },
    externalImports: [],
    files: [{ rel: 'src/m.ts', text: 'export function f() {}\n', hash: '', role: 'source' }, ...tests.map((text, i) => ({ rel: `test/t${i}.test.ts`, text, hash: '', role: 'test' }))],
    ...over,
  }) as unknown as TargetAnalysis;

describe('existingTitles', () => {
  test('lists literal titles of tests that run; skipped, todo and computed titles are left out', () => {
    const src = [
      "import { describe, it, test } from 'vitest';",
      "test('plain', () => {});",
      'it(`template`, () => {});',
      "describe('group', () => { it('nested', () => {}); });",
      "describe.each([1])('each group %i', () => { it('in each group', () => {}); });",
      "it.skip('skipped', () => {});",
      "test.todo('todo');",
      "describe.skip('skipped group', () => { it('inside skipped group', () => {}); });",
      "describe.skip.each([1])('skipped each %i', () => { it('inside skipped each', () => {}); });",
      "describe.todo('todo group');",
      "test.each([1])('each %i', () => {});",
      "it.for([1])('for %i', () => {});",
      "const name = 'computed';",
      'test(name, () => {});',
      'it(`with ${name}`, () => {});',
      "// test('in a comment', () => {});",
      "helper.test('not vitest', () => {});",
    ].join('\n');
    expect(existingTitles(analysis([src]))).toEqual(['plain', 'template', 'nested', 'in each group']);
  });

  test('reads only test files', () => {
    const a = analysis(["test('a', () => {});"]);
    a.files[0].text = "test('in a source file', () => {});\n";
    expect(existingTitles(a)).toEqual(['a']);
  });
});

describe('buildPrompt', () => {
  test('names external modules and says their code is not shown', () => {
    const a = analysis([], { externalImports: ['node:path', 'tiny-slug'] });
    const p = buildPrompt(a, evidenceFiles(a), { maxCases: 8, existingTitles: [] });
    expect(p).toContain('- These imports are external modules (Node.js built-ins or installed packages) whose code is not shown: "node:path", "tiny-slug".');
    expect(p.match(/^=== F\d+: .*$/gm)).toEqual(['=== F1: src/m.ts ===']);
  });

  test('says nothing about external modules when there are none', () => {
    const a = analysis([]);
    expect(buildPrompt(a, evidenceFiles(a), { maxCases: 8, existingTitles: [] })).not.toContain('external modules');
  });
});
