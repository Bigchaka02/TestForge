import { describe, expect, test } from 'vitest';
import { LIMITS } from '../../src/core/types';
import { caseFingerprint, checkJsonValue, EvidenceFile, parseModelText, validatePlan } from '../../src/generation/validate';

const FILES: EvidenceFile[] = [
  { id: 'F1', rel: 'src/age.ts', lines: ['/** Eligible when age is at least 18. */', 'export function isEligible(age: number): boolean {', '  return age >= 18;', '}'] },
];

const baseCase = (over: Record<string, unknown> = {}) => ({
  title: 'age 18 is eligible',
  category: 'boundary',
  args: [18],
  expectation: { kind: 'returns', value: true },
  basis: 'documented',
  evidence: [{ fileId: 'F1', startLine: 1, endLine: 1, excerpt: 'Eligible when age is at least 18.' }],
  rationale: 'at least 18',
  ...over,
});

const plan = (cases: unknown[], over: Record<string, unknown> = {}) => ({ schemaVersion: 1, exportName: 'isEligible', cases, unresolvedQuestions: [], ...over });

const opts = (over: Partial<Parameters<typeof validatePlan>[1]> = {}) => ({ exportName: 'isEligible', files: FILES, known: new Set<string>(), existing: [], maxAccepted: 8, ...over });

describe('validatePlan envelope', () => {
  test('accepts a valid plan', () => {
    const r = validatePlan(plan([baseCase()]), opts());
    expect(r.cases).toHaveLength(1);
    expect(r.cases[0].status).toBe('accepted');
    expect(r.cases[0].id).toMatch(/^tf-[0-9a-f]{8}$/);
    expect(r.cases[0].fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  test('rejects wrong schema version', () => {
    expect(() => validatePlan(plan([baseCase()], { schemaVersion: 2 }), opts())).toThrow(/schema/);
  });

  test('rejects unknown keys at every level', () => {
    expect(() => validatePlan(plan([baseCase()], { extra: 1 }), opts())).toThrow(/schema/);
    expect(() => validatePlan(plan([baseCase({ code: 'eval(1)' })]), opts())).toThrow(/schema/);
    expect(() => validatePlan(plan([baseCase({ expectation: { kind: 'returns', value: 1, code: 'x' } })]), opts())).toThrow(/schema/);
    expect(() => validatePlan(plan([baseCase({ evidence: [{ fileId: 'F1', startLine: 1, endLine: 1, excerpt: 'Eligible', more: 1 }] })]), opts())).toThrow(/schema/);
  });

  test('rejects a missing returns value', () => {
    expect(() => validatePlan(plan([baseCase({ expectation: { kind: 'returns' } })]), opts())).toThrow(/schema/);
  });

  test('rejects the wrong export name', () => {
    expect(() => validatePlan(plan([baseCase()], { exportName: 'other' }), opts())).toThrow(/exportName must be "isEligible"/);
  });

  test('rejects more than maxCases cases in the envelope', () => {
    const many = Array.from({ length: LIMITS.maxCases + 1 }, (_, i) => baseCase({ args: [i], basis: 'inferred', evidence: [] }));
    expect(() => validatePlan(plan(many), opts())).toThrow(/schema/);
  });

  test('rejects "__proto__" at the case level as an unknown key', () => {
    const raw = parseModelText(`{"schemaVersion":1,"exportName":"isEligible","unresolvedQuestions":[],"cases":[{"__proto__":{"x":1},"title":"t","category":"normal","args":[],"expectation":{"kind":"returns","value":1},"basis":"inferred","evidence":[],"rationale":""}]}`);
    expect(() => validatePlan(raw, opts())).toThrow(/schema/);
  });
});

describe('validatePlan per-case checks', () => {
  const statusOf = (c: Record<string, unknown>) => validatePlan(plan([c]), opts()).cases[0];

  test('non-finite numbers are rejected', () => {
    expect(statusOf(baseCase({ args: [Infinity], basis: 'inferred', evidence: [] }))).toMatchObject({ status: 'rejected', rejectReason: 'non-finite number' });
    expect(statusOf(baseCase({ expectation: { kind: 'returns', value: NaN }, basis: 'inferred', evidence: [] }))).toMatchObject({ status: 'rejected' });
  });

  test('too-deep values are rejected', () => {
    let deep: unknown = 1;
    for (let i = 0; i < LIMITS.jsonDepth + 2; i++) deep = [deep];
    expect(statusOf(baseCase({ args: [deep], basis: 'inferred', evidence: [] }))).toMatchObject({ status: 'rejected', rejectReason: expect.stringMatching(/nesting deeper/) });
  });

  test.each(['__proto__', 'constructor', 'prototype'])('prototype key %s inside a value is rejected', (key) => {
    const raw = parseModelText(
      JSON.stringify(plan([baseCase({ basis: 'inferred', evidence: [] })])).replace('"args":[18]', `"args":[{"${key}":{"polluted":true}}]`),
    );
    const r = validatePlan(raw, opts());
    expect(r.cases[0]).toMatchObject({ status: 'rejected', rejectReason: `forbidden key "${key}"` });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('prototype keys nested in the expected value are rejected', () => {
    const raw = parseModelText(
      JSON.stringify(plan([baseCase({ basis: 'inferred', evidence: [] })])).replace('"value":true', '"value":{"a":[{"__proto__":1}]}'),
    );
    expect(validatePlan(raw, opts()).cases[0].status).toBe('rejected');
  });

  test('evidence excerpt must be in the cited lines (whitespace-normalized)', () => {
    expect(statusOf(baseCase()).status).toBe('accepted');
    expect(statusOf(baseCase({ evidence: [{ fileId: 'F1', startLine: 1, endLine: 2, excerpt: 'at   least 18. */\n export function' }] })).status).toBe('accepted');
    expect(statusOf(baseCase({ evidence: [{ fileId: 'F1', startLine: 2, endLine: 3, excerpt: 'Eligible when age is at least 18.' }] }))).toMatchObject({
      status: 'rejected',
      rejectReason: expect.stringMatching(/excerpt not found/),
    });
    expect(statusOf(baseCase({ evidence: [{ fileId: 'F1', startLine: 1, endLine: 1, excerpt: 'at most 18' }] })).status).toBe('rejected');
  });

  test('whitespace-only excerpts do not count as evidence', () => {
    expect(statusOf(baseCase({ evidence: [{ fileId: 'F1', startLine: 1, endLine: 1, excerpt: '   ' }] })).status).toBe('rejected');
  });

  test('evidence must cite a known file and in-range lines', () => {
    expect(statusOf(baseCase({ evidence: [{ fileId: 'F9', startLine: 1, endLine: 1, excerpt: 'x' }] }))).toMatchObject({ status: 'rejected', rejectReason: 'evidence cites unknown file F9' });
    expect(statusOf(baseCase({ evidence: [{ fileId: 'F1', startLine: 3, endLine: 99, excerpt: 'x' }] })).rejectReason).toMatch(/outside/);
    expect(statusOf(baseCase({ evidence: [{ fileId: 'F1', startLine: 3, endLine: 2, excerpt: 'x' }] })).rejectReason).toMatch(/outside/);
  });

  test('documented cases without evidence are rejected; inferred ones are fine', () => {
    expect(statusOf(baseCase({ evidence: [] })).rejectReason).toMatch(/needs evidence/);
    expect(statusOf(baseCase({ basis: 'existing-test', evidence: [] })).status).toBe('rejected');
    expect(statusOf(baseCase({ basis: 'inferred', evidence: [] })).status).toBe('accepted');
  });

  test('duplicates are skipped and counted, including known fingerprints', () => {
    const r = validatePlan(plan([baseCase(), baseCase({ title: 'same data, other title' })]), opts());
    expect(r.cases).toHaveLength(1);
    expect(r.duplicatesSkipped).toBe(1);
    const known = new Set([caseFingerprint({ args: [18], expectation: { kind: 'returns', value: true } })]);
    const r2 = validatePlan(plan([baseCase()]), opts({ known }));
    expect(r2.cases).toHaveLength(0);
    expect(r2.duplicatesSkipped).toBe(1);
  });

  test('fingerprints ignore key order', () => {
    const a = caseFingerprint({ args: [{ a: 1, b: 2 }], expectation: { kind: 'returns', value: 1 } });
    const b = caseFingerprint({ args: [{ b: 2, a: 1 }], expectation: { kind: 'returns', value: 1 } });
    expect(a).toBe(b);
  });

  test('same inputs with a different expectation is a conflict', () => {
    const r = validatePlan(plan([baseCase(), baseCase({ expectation: { kind: 'returns', value: false } })]), opts());
    expect(r.cases.map((c) => c.status)).toEqual(['accepted', 'conflict']);
    expect(r.cases[1].rejectReason).toContain(r.cases[0].id);
  });

  test('conflicts are detected against earlier accepted cases', () => {
    const first = validatePlan(plan([baseCase()]), opts()).cases;
    const r = validatePlan(plan([baseCase({ expectation: { kind: 'throws' } })]), opts({ existing: first }));
    expect(r.cases[0].status).toBe('conflict');
  });

  test('case limit rejects cases beyond maxAccepted', () => {
    const cases = [1, 2, 3].map((n) => baseCase({ args: [n], basis: 'inferred', evidence: [] }));
    const r = validatePlan(plan(cases), opts({ maxAccepted: 2 }));
    expect(r.cases.map((c) => c.status)).toEqual(['accepted', 'accepted', 'rejected']);
    expect(r.cases[2].rejectReason).toMatch(/case limit \(2\)/);
  });

  test('oversized cases are rejected', () => {
    const big = Array.from({ length: 3 }, () => 'x'.repeat(3_500));
    expect(statusOf(baseCase({ args: big, basis: 'inferred', evidence: [] })).rejectReason).toMatch(/larger than/);
  });
});

describe('checkJsonValue', () => {
  test('accepts plain JSON and rejects other values', () => {
    expect(checkJsonValue({ a: [1, 'x', null, true, { b: 2 }] })).toBeUndefined();
    expect(checkJsonValue(undefined)).toMatch(/unsupported/);
    expect(checkJsonValue(() => 1)).toMatch(/unsupported/);
    expect(checkJsonValue(new Date())).toMatch(/unsupported/);
    expect(checkJsonValue(-Infinity)).toBe('non-finite number');
    expect(checkJsonValue('x'.repeat(LIMITS.jsonString + 1))).toMatch(/string longer/);
    expect(checkJsonValue(new Array(LIMITS.jsonArray + 1).fill(0))).toMatch(/array longer/);
    expect(checkJsonValue(Object.create(null))).toMatch(/unsupported/);
  });
});

describe('parseModelText', () => {
  const body = '{"a": 1}';
  test('accepts bare JSON and one outer fence', () => {
    expect(parseModelText(body)).toEqual({ a: 1 });
    expect(parseModelText('```json\n' + body + '\n```')).toEqual({ a: 1 });
    expect(parseModelText('  ```\r\n' + body + '\r\n```  ')).toEqual({ a: 1 });
  });
  test('rejects prose around JSON, two values, and oversized text', () => {
    expect(() => parseModelText('Here you go: ' + body)).toThrow();
    expect(() => parseModelText('```json\n' + body + '\n```\nThanks!')).toThrow();
    expect(() => parseModelText(body + body)).toThrow();
    expect(() => parseModelText('"' + 'x'.repeat(LIMITS.maxResponseBytes) + '"')).toThrow(/larger than/);
  });
});
