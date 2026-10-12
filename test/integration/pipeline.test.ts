// Full pipeline runs against the real fixtures/sample project: real tsc and Vitest
// processes, a deterministic fake provider, temp run directories.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { runPipeline, PipelineInput } from '../../src/core/pipeline';
import type { RunReport } from '../../src/core/types';
import { sha256 } from '../../src/core/util';
import { FakeProvider } from '../../src/providers/fake';
import { summarize } from '../../src/ui/summary';

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

/**
 * PIDs of live processes whose command line (or, on Linux, working directory) mentions `dir`.
 * Matches the native real path too: on Windows the temp dir can be an 8.3 short alias of it.
 */
function processesUsing(dir: string): number[] {
  const names = [dir];
  try {
    names.push(fs.realpathSync.native(dir));
  } catch {
    // already removed
  }
  return [...new Set(names.flatMap((n) => processesMentioning(n)))];
}

function processesMentioning(needle: string): number[] {
  if (process.platform !== 'linux') return processesByCommandLine(needle);
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

/** macOS and Windows have no /proc: list command lines with ps or CIM instead. */
function processesByCommandLine(needle: string): number[] {
  const out =
    process.platform === 'win32'
      ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }'], { encoding: 'utf8' })
      : execFileSync('ps', ['-axww', '-o', 'pid=,args='], { encoding: 'utf8' });
  const pids: number[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && Number(m[1]) !== process.pid && m[2].includes(needle)) pids.push(Number(m[1]));
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
  const base = { root: ROOT, sourceAbs: path.join(SRC, file), exportName, tmpBase };
  // Audits take no provider; generate runs default to the fake one.
  const report = await runPipeline(over.mode === 'audit' ? { ...base, ...over, mode: 'audit' } : { ...base, provider: new FakeProvider(), ...over, mode: 'generate' });
  const ms = Date.now() - t0;
  // Cleanup happened for every exit path and nothing is left running.
  expect(report.cleanup).toBe('done');
  expect(fs.readdirSync(tmpBase)).toEqual([]);
  expect(processesUsing(tmpBase)).toEqual([]);
  expect(fs.readdirSync(SRC).sort()).toEqual(Object.keys(before).sort());
  for (const pkg of ['vitest', 'typescript']) expect(fs.existsSync(path.join(ROOT, 'node_modules', pkg, 'package.json'))).toBe(true);
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
    // Mutations: >= -> >, and the bound 18 -> 17 / 18 -> 19. The existing tests (17, 25) only catch 18 -> 17.
    expect(report.mutations.map((x) => `${x.original}->${x.replacement}`)).toEqual(['>=->>', '18->17', '18->19']);
    expect(report.mutations.find((x) => x.replacement === '17')!.baseline).toBe('killed');
    expect(report.scores.baseline).toEqual({ killed: 1, survived: 2, excluded: 0, rate: 1 / 3 });
    expect(report.scores.generated).toEqual({ killed: 3, survived: 0, excluded: 0, rate: 1 });
    expect(report.scores.comparison).toEqual({ denominator: 3, before: 1, after: 3, excluded: 0 });
    expect(report.generatedTestPath).toBe(`src/age.testforge.${report.runId}.test.ts`);
    expect(report.generatedTest).toContain("import { isEligible } from \"./age.js\";");
    expect(report.inputHashes['src/age.ts']).toBe(before['age.ts']);
  });

  // VS Code reports "d:\..." while Node and Vite use "D:\..."; mixing them loaded two copies of vitest.
  test.runIf(process.platform === 'win32')('a lower-case drive letter, as VS Code reports it, still runs', async () => {
    const lower = (p: string) => p.replace(/^[A-Z]:/, (d) => d.toLowerCase());
    expect(lower(ROOT)).not.toBe(ROOT);
    const { report } = await run('age.ts', 'isEligible', { root: lower(ROOT), sourceAbs: lower(path.join(SRC, 'age.ts')) });
    expect(report.failure).toBeUndefined();
    expect(report.status).toBe('completed');
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

  test('async: parseScore — awaited cases pass, async baseline test runs, mutants are killed', async () => {
    const { report } = await run('score.ts', 'parseScore');
    expect(report.failure).toBeUndefined();
    expect(report.status).toBe('completed');
    expect(report.baselineTests).toEqual(['src/score.test.ts']);
    expect(report.cases.filter((c) => c.status === 'accepted').map((c) => c.originalOutcome)).toEqual(['passed', 'passed', 'passed', 'passed']);
    expect(report.generatedTest).toContain('async () => {');
    expect(report.generatedTest).toContain('expect(await Reflect.apply(parseScore, undefined, args))');
    expect(report.mutations.length).toBeGreaterThan(0);
    const { comparison } = report.scores;
    expect(comparison).toBeDefined();
    expect(comparison!.after).toBeGreaterThan(comparison!.before);
  });

  test('improvement pass: clamp — one extra request kills real survivors, equivalent ones stay', async () => {
    const { report } = await run('clamp.ts', 'clamp', { mutationSample: 20 });
    expect(report.status).toBe('completed');
    expect(report.modelRequests).toBe(2);
    const added = report.cases.filter((c) => c.round === 'improvement');
    expect(added.map((c) => [c.title, c.status, c.originalOutcome])).toEqual([
      ['value above max clamps to max', 'accepted', 'passed'],
      ['max of exactly 0 is allowed', 'accepted', 'passed'],
    ]);
    for (const c of added) expect(report.generatedTest).toContain(`[${c.id}]`);
    expect(report.improvement).toEqual({ survivorsBefore: 4, proposed: 2, added: 2, killed: 2 });
    // value <= MIN -> < and value >= max -> > return the same value at the boundary: equivalent mutants.
    expect(report.mutations.filter((m) => m.generated === 'survived').map((m) => `${m.original}->${m.replacement}`)).toEqual(['<=-><', '>=->>']);
    expect(report.scores.generated).toEqual({ killed: 7, survived: 2, excluded: 0, rate: 7 / 9 });
  });

  test('improvement pass: a case that fails on the original code is rejected, the others are kept', async () => {
    const good = { ...inferred('above max', [15, 10], 10) };
    const wrong = { ...inferred('wrong expectation', [5, 0], 5) };
    const provider = new FakeProvider((prompt) =>
      prompt.includes('were not detected by the current tests') ? plan('clamp', [good, wrong]) : plan('clamp', [inferred('inside', [5, 10], 5)]),
    );
    const { report } = await run('clamp.ts', 'clamp', { provider, mutationSample: 20 });
    expect(report.status).toBe('completed');
    const byTitle = Object.fromEntries(report.cases.map((c) => [c.title, c]));
    expect(byTitle['above max']).toMatchObject({ round: 'improvement', status: 'accepted', originalOutcome: 'passed' });
    expect(byTitle['wrong expectation']).toMatchObject({ round: 'improvement', status: 'rejected', originalOutcome: 'failed' });
    expect(byTitle['wrong expectation'].rejectReason).toMatch(/failed against the original code/);
    expect(report.generatedTest).toContain(`[${byTitle['above max'].id}]`);
    expect(report.generatedTest).not.toContain(`[${byTitle['wrong expectation'].id}]`);
    expect(report.improvement!.added).toBe(1);
    expect(report.improvement!.killed).toBeGreaterThan(0);
    expect(report.limitations.join('\n')).toMatch(/failed against the original code and were not added/);
  });

  test('improvement pass: a provider error leaves earlier results standing; improve:false skips it', async () => {
    let calls = 0;
    const provider = new FakeProvider((prompt) => {
      calls++;
      if (prompt.includes('were not detected by the current tests')) throw new Error('quota exceeded');
      return plan('clamp', [inferred('inside', [5, 10], 5)]);
    });
    const { report } = await run('clamp.ts', 'clamp', { provider });
    expect(report.status).toBe('completed');
    expect(calls).toBe(2);
    expect(report.improvement).toMatchObject({ proposed: 0, added: 0, killed: 0 });
    expect(report.limitations.join('\n')).toMatch(/improvement request failed, so earlier results stand: quota exceeded/);

    const skipped = await run('clamp.ts', 'clamp', { improve: false });
    expect(skipped.report.improvement).toBeUndefined();
    expect(skipped.report.modelRequests).toBe(1);
  });

  test('joinWords — no supported mutation opportunities', async () => {
    const { report } = await run('strings.ts', 'joinWords');
    expect(report.status).toBe('completed');
    expect(report.mutations).toEqual([]);
    expect(report.limitations).toContain('No supported mutation opportunities.');
    expect(report.scores.generated).toEqual({ killed: 0, survived: 0, excluded: 0, rate: null });
  });

  test('hostile case titles render into tests that run and pass', async () => {
    const titles = ['quote \' " and `backtick` ${x}', 'closes */ comment', 'new\nline', 'sep\u2028arator', "'); process.exit(1); ('"];
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

  test('audit: isEligible — existing tests detect 1/3 mutations, no model request, no generated file', async () => {
    const { report } = await run('age.ts', 'isEligible', { mode: 'audit' });
    expect(report.failure).toBeUndefined();
    expect(report).toMatchObject({ mode: 'audit', status: 'completed', stage: 'completed', demo: false, model: 'none (audit only)', modelRequests: 0 });
    expect(report.baselineTests).toEqual(['src/age.test.ts']);
    expect(report.baselineRuns).toEqual(['completed', 'completed']);
    expect(report.contextFiles).toEqual([]);
    expect(report.cases).toEqual([]);
    expect(report.candidateRuns).toEqual([]);
    expect(report.generatedTest).toBeUndefined();
    expect(report.generatedTestPath).toBeUndefined();
    expect(Object.keys(report.stageMs)).toEqual(['preflight', 'snapshotting', 'checking-baseline', 'checking-mutations']);
    expect(report.scores).toEqual({ baseline: { killed: 1, survived: 2, excluded: 0, rate: 1 / 3 } });
    expect(report.mutations.map((m) => `${m.original}->${m.replacement}:${m.baseline}`)).toEqual(['>=->>:survived', '18->17:killed', '18->19:survived']);
    expect(report.mutations.find((m) => m.replacement === '17')!.detectingTests).toEqual(['age 17 is not eligible']);
    for (const m of report.mutations) expect(m.generated).toBeUndefined();
    expect(report.inputHashes['src/age.test.ts']).toBe(before['age.test.ts']);

    // The text the chat tool returns: score, every survivor, and where to add tests.
    const text = summarize(report);
    expect(text).toContain('Mutation score of the existing tests: 1/3 detected.');
    expect(text).toContain('- line 3: >= → >\n- line 3: 18 → 19');
    expect(text).toContain('- line 3: 18 → 17 (by: age 17 is not eligible)');
    expect(text).toMatch(/add test cases to src\/age\.test\.ts .* then call this tool again/);
    expect(text).not.toMatch(/Apply Tests/);
  });

  test('audit: clamp has no adjacent tests — unsupported with a clear reason, nothing runs', async () => {
    const { report } = await run('clamp.ts', 'clamp', { mode: 'audit' });
    expect(report.status).toBe('unsupported');
    expect(report.failure).toMatchObject({ kind: 'unsupported', message: 'There are no existing tests next to src/clamp.ts to audit. Add src/clamp.test.ts or use Generate & Verify Tests.' });
    expect(report.modelRequests).toBe(0);
    expect(report.baselineRuns).toEqual([]);
    expect(report.mutations).toEqual([]);
    expect(Object.keys(report.stageMs)).toEqual(['preflight']);
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
