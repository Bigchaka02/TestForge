import ts from 'typescript';
import { describe, expect, test } from 'vitest';
import { checkTestFile, parse } from '../../src/analysis/analyze';
import type { CaseRecord } from '../../src/core/types';
import { commentText, readFingerprints, renderTests } from '../../src/generation/render';
import { caseFingerprint } from '../../src/generation/validate';

const HOSTILE = [
  `it's "quoted"`,
  'back`tick` ${PWNED_TEMPLATE}',
  'closes */ a comment /* and // starts one',
  'multi\nline\r\ntitle\u0000with control',
  'line\u2028separator\u2029paragraph',
  `'); PWNED_CALL(); test.only('x', () => {}); ('`,
  '"); eval("PWNED_EVAL"); ("',
  '\\"; process.exit(1); //',
];

function record(title: string, args: unknown[], expectation: CaseRecord['expectation'], over: Partial<CaseRecord> = {}): CaseRecord {
  const fingerprint = caseFingerprint({ args: args as never, expectation });
  return {
    title,
    category: 'normal',
    args: args as never,
    expectation,
    basis: 'inferred',
    evidence: [],
    rationale: `rationale for ${title}\n*/ PWNED_RATIONALE() /*`,
    id: `tf-${fingerprint.slice(0, 8)}`,
    fingerprint,
    status: 'accepted',
    ...over,
  };
}

const cases: CaseRecord[] = [
  ...HOSTILE.map((t, i) => record(t, [t, i, { nested: [t] }], { kind: 'returns', value: { t, list: [null, true, 1.5] } })),
  record('throws with hostile message', ['x'], { kind: 'throws', errorName: 'Range"Error`', messageIncludes: '*/ PWNED_MSG()\n' }),
  record('throws, no details', [], { kind: 'throws' }),
  record('evidence comment', [1], { kind: 'returns', value: 1 }, { basis: 'documented', evidence: [{ fileId: 'F1\n*/PWNED_FILEID()', startLine: 1, endLine: 2, excerpt: 'x' }] }),
];

const render = (exportName = 'target') => renderTests({ runId: 'abcd1234', exportName, importPath: './target.js', cases, demo: true });

function walk(node: ts.Node, visit: (n: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, (c) => walk(c, visit));
}

describe('renderTests', () => {
  const src = render();
  const sf = parse('gen.test.ts', src);

  test('output has no syntax errors', () => {
    const out = ts.transpileModule(src, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    expect(out.diagnostics ?? []).toEqual([]);
  });

  test('hostile text never becomes code', () => {
    const identifiers = new Set<string>();
    walk(sf, (n) => {
      if (ts.isIdentifier(n)) identifiers.add(n.text);
    });
    for (const name of identifiers) expect(name).not.toMatch(/PWNED|^eval$|^process$|^only$|^skip$/);
    expect([...identifiers].sort()).toEqual(
      ['Error', 'JSON', 'Reflect', 'String', 'apply', 'args', 'data', 'error', 'expect', 'json', 'message', 'name', 'parse', 'target', 'test', 'threw', 'thrown', 'toBe', 'toContain', 'toStrictEqual', 'undefined'].sort(),
    );
  });

  test('contains no eval, only or skip', () => {
    // "eval" may appear inside string literals (hostile titles); it must never be code.
    walk(sf, (n) => {
      if (ts.isCallExpression(n)) expect(n.expression.getText(sf)).not.toMatch(/eval|Function|require|import/);
    });
    const members: string[] = [];
    walk(sf, (n) => {
      if (ts.isPropertyAccessExpression(n)) members.push(n.name.text);
    });
    expect(members).not.toContain('only');
    expect(members).not.toContain('skip');
    expect(members).not.toContain('todo');
  });

  test('line and paragraph separators and control characters are escaped', () => {
    expect(src).not.toMatch(/[\u2028\u2029\u0000]/);
    for (const line of src.split('\n')) expect(line).not.toContain('\r');
  });

  test('every case becomes one test whose title round-trips exactly', () => {
    const titles: string[] = [];
    walk(sf, (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'test') {
        const arg = n.arguments[0];
        expect(ts.isStringLiteral(arg)).toBe(true);
        titles.push((arg as ts.StringLiteral).text);
      }
    });
    expect(titles).toEqual(cases.map((c) => `[${c.id}] ${c.title}`));
  });

  test('embedded data round-trips through JSON', () => {
    const payloads: unknown[] = [];
    walk(sf, (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'data') payloads.push(JSON.parse((n.arguments[0] as ts.StringLiteral).text));
    });
    const expected = cases.flatMap((c) => [c.args, ...(c.expectation.kind === 'returns' ? [c.expectation.value] : [])]);
    expect(payloads).toEqual(expected);
  });

  test('throws expectations use string literals for name and message', () => {
    expect(src).toContain('expect((thrown as Error).name).toBe("Range\\"Error`");');
    expect(src).toContain('expect(String((thrown as Error).message)).toContain("*/ PWNED_MSG()\\n");');
  });

  test('comments are single-line and cannot close', () => {
    for (const line of src.split('\n').filter((l) => l.startsWith('//'))) expect(line).not.toContain('*/');
    expect(commentText('a\nb*/c\u2028d')).toBe('a b* /c d');
  });

  test('passes the baseline-test restrictions, so an applied file can be re-analyzed', () => {
    expect(checkTestFile(sf)).toEqual([]);
  });

  test('readFingerprints round-trips', () => {
    expect(readFingerprints(src)).toEqual(cases.map((c) => c.fingerprint));
  });

  test('is deterministic', () => {
    expect(render()).toBe(src);
  });

  test('rejects non-identifier export names', () => {
    expect(() => render('a; eval("x")')).toThrow(/invalid export name/);
    expect(() => render('')).toThrow(/invalid export name/);
  });

  test.each(['data', 'test', 'expect', 'args'])('an export named %s is imported under an alias', (name) => {
    const out = render(name);
    expect(out).toContain(`import { ${name} as subject } from "./target.js";`);
    expect(out).toContain('Reflect.apply(subject, undefined, args)');
    const d = ts.transpileModule(out, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext } }).diagnostics;
    expect(d ?? []).toEqual([]);
  });

  test('refuses non-JSON values even if a caller skips validation', () => {
    const bad = record('bad', [NaN], { kind: 'returns', value: 1 });
    expect(() => renderTests({ runId: 'x', exportName: 'f', importPath: './f.js', cases: [bad], demo: false })).toThrow(/non-finite/);
  });
});
