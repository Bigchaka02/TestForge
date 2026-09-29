// Full pipeline runs against the real fixtures/sample project: real tsc and Vitest
// processes, a deterministic fake provider, temp run directories.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { runPipeline, PipelineInput } from '../../src/core/pipeline';
import type { RunReport } from '../../src/core/types';
import { sha256 } from '../../src/core/util';
import { FakeProvider } from '../../src/providers/fake';

const ROOT = path.resolve(__dirname, '../../fixtures/sample');
const SRC = path.join(ROOT, 'src');

function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(dir, { recursive: true }) as string[]) {
    const abs = path.join(dir, name);
    if (fs.statSync(abs).isFile()) out[name.split(path.sep).join('/')] = sha256(fs.readFileSync(abs));
  }
  return out;
}

/** PIDs of live processes whose command line or working directory mentions `needle`. */
function processesUsing(needle: string): number[] {
  const pids: number[] = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
      let cwd = '';
      try {
        cwd = fs.readlinkSync(`/proc/${entry}/cwd`);
      } catch {
        // not readable
      }
      if (cmd.includes(needle) || cwd.includes(needle)) pids.push(Number(entry));
    } catch {
      // process exited
    }
  }
  return pids;
}

const MODULES = path.join(ROOT, 'node_modules');
let before: Record<string, string>;
let rootEntries: string[];
let moduleEntries: string[];
const tmpBases: string[] = [];
beforeAll(() => {
  before = hashTree(SRC);
  rootEntries = fs.readdirSync(ROOT).sort();
  moduleEntries = fs.readdirSync(MODULES).sort();
});
afterAll(() => {
  for (const d of tmpBases) fs.rmSync(d, { recursive: true, force: true });
});

function newTmpBase(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'testforge-it-'));
  tmpBases.push(d);
  return d;
}

async function run(file: string, exportName: string, over: Partial<PipelineInput> = {}): Promise<{ report: RunReport; tmpBase: string; ms: number }> {
  const tmpBase = over.tmpBase ?? newTmpBase();
  const t0 = Date.now();
  const report = await runPipeline({ root: ROOT, sourceAbs: path.join(SRC, file), exportName, provider: new FakeProvider(), tmpBase, ...over });
  const ms = Date.now() - t0;
  // Cleanup happened for every exit path and nothing is left running.
  expect(report.cleanup).toBe('done');
  expect(fs.readdirSync(tmpBase)).toEqual([]);
  expect(processesUsing(tmpBase)).toEqual([]);
  expect(fs.readdirSync(SRC).sort()).toEqual(Object.keys(before).sort());
  return { report, tmpBase, ms };
}

const plan = (exportName: string, cases: unknown[]) => JSON.stringify({ schemaVersion: 1, exportName, cases, unresolvedQuestions: [] });
const inferred = (title: string, args: unknown[], value: unknown) => ({ title, category: 'normal', args, expectation: { kind: 'returns', value }, basis: 'inferred', evidence: [], rationale: 'r' });

describe('pipeline on fixtures/sample', () => {
  test('A10: isEligible — baseline misses >= -> >, generated suite detects it', async () => {
    const { report } = await run('age.ts', 'isEligible');
    expect(report.failure).toBeUndefined();
    expect(report.status).toBe('completed');
    expect(report.stage).toBe('completed');
    expect(report.demo).toBe(true);
    expect(report.baselineTests).toEqual(['src/age.test.ts']);
    expect(report.baselineRuns).toEqual(['completed', 'completed']);
    expect(report.candidateRuns).toEqual(['completed', 'completed']);
    const accepted = report.cases.filter((c) => c.status === 'accepted');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ args: [18], basis: 'documented', originalOutcome: 'passed' });
    expect(accepted[0].evidence[0]).toMatchObject({ fileId: 'F1', startLine: 1, endLine: 1 });

    const m = report.mutations.find((x) => x.original === '>=' && x.replacement === '>');
    expect(m).toBeDefined();
    expect(m!.baseline).toBe('survived');
    expect(m!.generated).toBe('killed');
    expect(m!.detectingTests).toEqual([`[${accepted[0].id}] age 18 is eligible (boundary)`]);
    expect(report.scores.baseline).toEqual({ killed: 0, survived: report.mutations.length, excluded: 0, rate: 0 });
    expect(report.scores.generated?.killed).toBe(report.mutations.length);
    expect(report.scores.comparison).toEqual({ denominator: report.mutations.length, before: 0, after: report.mutations.length, excluded: 0 });
    expect(report.generatedTestPath).toBe(`src/age.testforge.${report.runId}.test.ts`);
    expect(report.generatedTest).toContain("import { isEligible } from \"./age.js\";");
    expect(report.inputHashes['src/age.ts']).toBe(before['age.ts']);
  });

  test('A07: finalPrice — documented "exactly 100 costs 90" fails on buggy code and is kept', async () => {
    const { report } = await run('discount.ts', 'finalPrice');
    expect(report.status).toBe('partial');
    expect(report.failure).toBeUndefined();
    const c100 = report.cases.find((c) => c.title === 'member order of exactly 100 costs 90')!;
    expect(c100).toMatchObject({ status: 'accepted', basis: 'documented', originalOutcome: 'failed' });
    expect(c100.failureMessage).toMatch(/90/);
    const c200 = report.cases.find((c) => c.title === 'member order of 200 costs 180')!;
    expect(c200.originalOutcome).toBe('passed');
    expect(report.generatedTest).toContain(`[${c100.id}] member order of exactly 100 costs 90`);
    expect(report.mutations).toEqual([]);
    expect(report.scores).toEqual({});
    expect(report.limitations.join('\n')).toMatch(/fail against the original code/);
  });

  test('hanging: countDown(-1) times out; run ends partial in bounded time', async () => {
    const { report, ms } = await run('slow.ts', 'countDown');
    expect(report.status).toBe('partial');
    expect(report.failure).toBeUndefined();
    expect(report.candidateRuns).toEqual(['timeout']);
    const neg = report.cases.find((c) => c.title === 'negative input')!;
    expect(neg.status).toBe('accepted');
    expect(neg.originalOutcome).not.toBe('passed');
    expect(['timeout', 'not-run']).toContain(neg.originalOutcome);
    expect(report.mutations).toEqual([]);
    expect(report.scores).toEqual({});
    expect(report.limitations.join('\n')).toMatch(/timed out against the original code/);
    expect(ms).toBeLessThan(40_000);
  });

  test('no baseline: clamp — no comparison, generated score present, throws case passes', async () => {
    const { report } = await run('clamp.ts', 'clamp');
    expect(report.status).toBe('completed');
    expect(report.baselineTests).toEqual([]);
    expect(report.baselineRuns).toEqual([]);
    expect(report.contextFiles).toEqual(['src/clamp.ts', 'src/limits.ts']);
    expect(report.limitations.join('\n')).toMatch(/No baseline tests/);
    expect(report.scores.comparison).toBeUndefined();
    expect(report.scores.baseline).toBeUndefined();
    expect(report.scores.generated).toBeDefined();
    expect(report.scores.generated!.killed + report.scores.generated!.survived + report.scores.generated!.excluded).toBe(report.mutations.length);
    expect(report.mutations.length).toBeGreaterThan(0);
    for (const m of report.mutations) expect(m.baseline).toBeUndefined();
    const throwsCase = report.cases.find((c) => c.expectation.kind === 'throws')!;
    expect(throwsCase).toMatchObject({ status: 'accepted', originalOutcome: 'passed', expectation: { errorName: 'RangeError', messageIncludes: 'max must be' } });
    expect(report.generatedTest).toContain('expect((thrown as Error).name).toBe("RangeError");');
    expect(report.cases.every((c) => c.originalOutcome === 'passed')).toBe(true);
  });

  test('joinWords — no supported mutation opportunities', async () => {
    const { report } = await run('strings.ts', 'joinWords');
    expect(report.status).toBe('completed');
    expect(report.mutations).toEqual([]);
    expect(report.limitations).toContain('No supported mutation opportunities.');
    expect(report.scores.generated).toEqual({ killed: 0, survived: 0, excluded: 0, rate: null });
  });

  test('hostile case titles render into tests that run and pass', async () => {
    const titles = ['quote \' " and `backtick` ${x}', 'closes */ comment', 'new\nline', 'sep arator', "'); process.exit(1); ('"];
    const provider = new FakeProvider(() => plan('joinWords', titles.map((t, i) => inferred(t, [[t, String(i)]], `${t} ${i}`))));
    const { report } = await run('strings.ts', 'joinWords', { provider });
    expect(report.status).toBe('completed');
    expect(report.cases.map((c) => c.originalOutcome)).toEqual(titles.map(() => 'passed'));
  });

  test('invalid model output, then a valid correction', async () => {
    const provider = new FakeProvider((prompt, attempt) => (attempt === 0 ? 'Sure! Here are some tests: {' : plan('joinWords', [inferred('two words', [['a', 'b']], 'a b')])));
    const { report } = await run('strings.ts', 'joinWords', { provider });
    expect(report.modelRequests).toBe(2);
    expect(provider.requests).toBe(2);
    expect(report.status).toBe('completed');
    expect(report.cases).toHaveLength(1);
    expect(report.cases[0].originalOutcome).toBe('passed');
  });

  test('schema-invalid output on both attempts fails with invalid-response', async () => {
    const provider = new FakeProvider((prompt, attempt) => (attempt === 0 ? '{"schemaVersion":1}' : plan('notJoinWords', [])));
    const { report } = await run('strings.ts', 'joinWords', { provider });
    expect(report.modelRequests).toBe(2);
    expect(report.status).toBe('failed');
    expect(report.failure?.kind).toBe('invalid-response');
    expect(report.failure?.message).toMatch(/exportName must be "joinWords"/);
    expect(report.generatedTest).toBeUndefined();
  });

  test('A13: cancelling mid-run stops processes and removes the run directory', async () => {
    const ctrl = new AbortController();
    const tmpBase = newTmpBase();
    let abortedAt = 0;
    let runningBeforeAbort = 0;
    const onStage = (stage: string) => {
      if (stage === 'validating-candidates' && !abortedAt) {
        // countDown(-1) spins forever, so Vitest is certainly running when we abort.
        setTimeout(() => {
          runningBeforeAbort = processesUsing(tmpBase).length;
          abortedAt = Date.now();
          ctrl.abort();
        }, 2_000);
      }
    };
    const { report } = await run('slow.ts', 'countDown', { signal: ctrl.signal, onStage, tmpBase });
    const afterAbort = Date.now() - abortedAt;
    expect(abortedAt).toBeGreaterThan(0);
    // The process probe really sees the Vitest processes (so the "none left" check in run() means something).
    expect(runningBeforeAbort).toBeGreaterThan(0);
    expect(report.status).toBe('cancelled');
    expect(report.failure?.kind).toBe('cancelled');
    expect(afterAbort).toBeLessThan(5_000);
  });

  test('the global deadline ends the run as partial, not completed', async () => {
    const { report, ms } = await run('slow.ts', 'countDown', { globalDeadlineMs: 6_000 });
    expect(report.status).toBe('partial');
    expect(report.failure?.kind).toBe('deadline');
    expect(ms).toBeLessThan(12_000);
  });

  test('a signal aborted before the run starts cancels it', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { report } = await run('age.ts', 'isEligible', { signal: ctrl.signal });
    expect(report.status).toBe('cancelled');
    expect(report.modelRequests).toBe(0);
  });

  test('unsupported target is reported, not thrown', async () => {
    const { report } = await run('age.ts', 'nope');
    expect(report.status).toBe('unsupported');
    expect(report.failure?.kind).toBe('unsupported');
  });

  test('A16: fixture sources are byte-for-byte unchanged after all runs', () => {
    expect(hashTree(SRC)).toEqual(before);
    expect(fs.readdirSync(ROOT).sort()).toEqual(rootEntries);
  });

  test('runs write nothing into the project node_modules (no .vite-temp)', () => {
    expect(fs.existsSync(path.join(MODULES, '.vite-temp'))).toBe(false);
    expect(fs.readdirSync(MODULES).sort()).toEqual(moduleEntries);
  });
});
