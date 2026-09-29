// Orchestrates one Generate & Verify run. vscode-free so it runs under Vitest.
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzeTarget } from '../analysis/analyze';
import { buildPrompt, correctionPrompt, evidenceFiles, existingTitles } from '../generation/prompt';
import { readFingerprints, renderTests } from '../generation/render';
import { parseModelText, validatePlan, ValidationResult } from '../generation/validate';
import { resolveNode, resolveTools, runVitest, typeCheck } from '../execution/runner';
import { createCopy, createRunDir, removeRunDir, RunDir, writeConfigs, writeFile } from '../execution/workspace';
import { applyMutation, classify, compare, enumerateMutations, score } from '../mutation/mutate';
import type { ModelProvider } from '../providers/provider';
import { LIMITS, RunReport, Stage, SuiteRun, TerminalStatus, TestForgeError } from './types';
import { newRunId, sha256 } from './util';

export interface PipelineInput {
  root: string;
  sourceAbs: string;
  exportName: string;
  provider: ModelProvider;
  nodePath?: string;
  mutationSample?: number;
  globalDeadlineMs?: number;
  signal?: AbortSignal;
  onStage?: (stage: Stage, message: string) => void;
  tmpBase?: string;
}

const id = (file: string, title: string) => `${file}::${title}`;
const signature = (r: SuiteRun) => r.tests.map((t) => `${id(t.file, t.title)}=${t.status}`).sort().join('\n');

const STATUS_FOR: Record<TestForgeError['kind'], TerminalStatus> = {
  unsupported: 'unsupported',
  blocked: 'blocked',
  setup: 'blocked',
  cancelled: 'cancelled',
  deadline: 'partial',
  'original-type-error': 'failed',
  'baseline-failure': 'failed',
  unstable: 'failed',
  provider: 'failed',
  'invalid-response': 'failed',
  infrastructure: 'failed',
};

export async function runPipeline(input: PipelineInput): Promise<RunReport> {
  const runId = newRunId();
  const report: RunReport = {
    schemaVersion: 1,
    runId,
    status: 'failed',
    stage: 'idle',
    demo: input.provider.isFake,
    scope: 'selected-module test scope',
    exportName: input.exportName,
    sourceFile: path.relative(input.root, input.sourceAbs).split(path.sep).join('/'),
    inputHashes: {},
    model: input.provider.label,
    toolVersions: {},
    startedAt: new Date().toISOString(),
    stageMs: {},
    contextFiles: [],
    contextExclusions: [],
    baselineTests: [],
    cases: [],
    duplicatesSkipped: 0,
    unresolvedQuestions: [],
    baselineRuns: [],
    candidateRuns: [],
    mutations: [],
    scores: {},
    modelRequests: 0,
    limitations: [],
    cleanup: 'pending',
  };
  if (input.provider.isFake) report.limitations.push('DEMO mode: cases come from a deterministic fake provider, not an AI model.');

  const ctrl = new AbortController();
  const sig = ctrl.signal;
  const deadlineMs = Math.min(input.globalDeadlineMs ?? LIMITS.globalDeadlineMs, 600_000);
  const deadline = setTimeout(() => ctrl.abort(new TestForgeError('deadline', `The ${deadlineMs / 1000}s run deadline was reached; results are partial.`)), deadlineMs);
  const onUserAbort = () => ctrl.abort(new TestForgeError('cancelled', 'Cancelled by the user.'));
  if (input.signal?.aborted) onUserAbort();
  input.signal?.addEventListener('abort', onUserAbort, { once: true });
  const checkAbort = () => {
    if (sig.aborted) throw sig.reason;
  };

  let stageStart = Date.now();
  const stage = (s: Stage, message: string) => {
    const now = Date.now();
    if (report.stage !== 'idle') report.stageMs[report.stage] = (report.stageMs[report.stage] ?? 0) + (now - stageStart);
    stageStart = now;
    report.stage = s;
    input.onStage?.(s, message);
  };

  let run: RunDir | undefined;
  let partial = false;
  try {
    // Stage 1-2: preflight and freeze inputs
    stage('preflight', 'Checking project support');
    const a = analyzeTarget(input.root, input.sourceAbs, input.exportName);
    report.toolVersions = { ...a.toolVersions };
    report.baselineTests = a.baselineTests;
    report.contextFiles = a.files.map((f) => f.rel);
    report.contextExclusions = a.exclusions;
    for (const f of a.files) report.inputHashes[f.rel] = f.hash;
    Object.assign(report.inputHashes, a.packageHashes);

    stage('snapshotting', 'Copying files to a temporary run directory');
    run = createRunDir(runId, input.tmpBase ?? os.tmpdir());
    const node = await resolveNode(input.nodePath, run.tmp);
    report.toolVersions.node = node.version;
    const tools = resolveTools(input.root, node.path);
    const sources = a.files.filter((f) => f.role === 'source').map((f) => f.rel);
    const copy = createCopy(run, 'original', input.root, a.files, a.baselineTests);

    // Stage 3: original must type-check
    const tc = await typeCheck(tools, copy, run.tmp, sig);
    checkAbort();
    if (!tc.ok) throw new TestForgeError('original-type-error', tc.timedOut ? 'Type checking the original project timed out.' : 'The original code does not type-check, so TestForge stopped before generating tests.', tc.output);

    // Stage 4: baseline suite A, twice
    stage('checking-baseline', 'Running existing tests');
    let baselineIds = new Set<string>();
    if (a.baselineTests.length) {
      const runs: SuiteRun[] = [];
      for (let i = 0; i < 2; i++) {
        const r = await runVitest(tools, copy, run.tmp, a.baselineTests, sig);
        checkAbort();
        report.baselineRuns.push(r.status);
        if (r.status !== 'completed') throw new TestForgeError('infrastructure', `Existing tests could not be run (${r.status}).`, r.error);
        const failed = r.tests.filter((t) => t.status === 'failed');
        if (failed.length) throw new TestForgeError('baseline-failure', `Pre-existing test failure: ${failed.map((t) => t.title).join(', ')}. Fix existing tests first.`, failed[0].message);
        runs.push(r);
      }
      if (signature(runs[0]) !== signature(runs[1])) throw new TestForgeError('unstable', 'Existing tests gave different results on two runs; scoring stopped.');
      baselineIds = new Set(runs[0].tests.map((t) => id(t.file, t.title)));
    } else {
      report.limitations.push('No baseline tests were found next to the module, so there is no before/after comparison.');
    }

    // Stage 5: generate candidates (data only)
    stage('generating', `Requesting test cases from ${input.provider.label}`);
    const evFiles = evidenceFiles(a);
    const known = new Set(a.files.filter((f) => f.role === 'test').flatMap((f) => readFingerprints(f.text)));
    const firstPrompt = buildPrompt(a, evFiles, { maxCases: LIMITS.initialCases, existingTitles: existingTitles(a) });
    let prompt = firstPrompt;
    const history: { role: 'user' | 'assistant'; text: string }[] = [];
    let result: ValidationResult | undefined;
    let lastError = '';
    for (let attempt = 0; attempt < 2 && report.modelRequests < LIMITS.maxModelRequests; attempt++) {
      const reqCtrl = new AbortController();
      const reqTimer = setTimeout(() => reqCtrl.abort(), LIMITS.modelDeadlineMs);
      const onAbort = () => reqCtrl.abort();
      sig.addEventListener('abort', onAbort, { once: true });
      let text: string;
      try {
        report.modelRequests++;
        text = await input.provider.complete(prompt, history, reqCtrl.signal);
      } catch (e) {
        checkAbort();
        if (reqCtrl.signal.aborted) throw new TestForgeError('provider', `The model did not answer within ${LIMITS.modelDeadlineMs / 1000}s.`);
        throw new TestForgeError('provider', `Model request failed: ${(e as Error).message}`);
      } finally {
        clearTimeout(reqTimer);
        sig.removeEventListener('abort', onAbort);
      }
      checkAbort();
      try {
        result = validatePlan(parseModelText(text), { exportName: a.exportName, files: evFiles, known, existing: [], maxAccepted: LIMITS.initialCases });
        break;
      } catch (e) {
        lastError = (e as Error).message;
        history.push({ role: 'user', text: prompt }, { role: 'assistant', text });
        prompt = correctionPrompt(lastError);
      }
    }
    if (!result) throw new TestForgeError('invalid-response', `The model response was rejected after ${report.modelRequests} request(s): ${lastError}`);
    report.cases = result.cases;
    report.duplicatesSkipped = result.duplicatesSkipped;
    report.unresolvedQuestions = result.plan.unresolvedQuestions;
    const accepted = result.cases.filter((c) => c.status === 'accepted');
    if (!accepted.length) {
      report.limitations.push('The model proposed no acceptable new cases.');
      partial = true;
      return report;
    }

    const base = path.posix.basename(report.sourceFile, '.ts');
    const genRel = path.posix.join(path.posix.dirname(report.sourceFile), `${base}.testforge.${runId}.test.ts`);
    report.generatedTestPath = genRel;
    report.generatedTest = renderTests({ runId, exportName: a.exportName, importPath: `./${base}.js`, cases: accepted, demo: input.provider.isFake });

    // Stage 6: suite B (baseline + generated) against original code, twice
    stage('validating-candidates', 'Running generated tests against the original code');
    const allTests = [...a.baselineTests, genRel];
    writeFile(copy, genRel, report.generatedTest);
    writeConfigs(copy, sources, allTests);
    const tc2 = await typeCheck(tools, copy, run.tmp, sig);
    checkAbort();
    if (!tc2.ok) throw new TestForgeError('infrastructure', 'The generated test file did not type-check (a TestForge rendering problem, not your code).', tc2.output);
    const cRuns: SuiteRun[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await runVitest(tools, copy, run.tmp, allTests, sig);
      checkAbort();
      report.candidateRuns.push(r.status);
      cRuns.push(r);
      if (r.status === 'error') throw new TestForgeError('infrastructure', 'The generated tests could not be collected or run.', r.error);
      if (r.status === 'timeout') break;
    }
    for (const c of accepted) {
      const t = cRuns[0].tests.find((x) => x.file === genRel && x.title.startsWith(`[${c.id}]`));
      c.originalOutcome = !t ? 'not-run' : t.timedOut ? 'timeout' : t.status === 'passed' ? 'passed' : 'failed';
      if (t?.message) c.failureMessage = t.message;
    }
    if (cRuns[0].status === 'timeout' || accepted.some((c) => c.originalOutcome !== 'passed')) {
      report.limitations.push(
        cRuns[0].status === 'timeout'
          ? 'A test timed out against the original code, so mutation scoring was skipped.'
          : 'Some generated cases fail against the original code. They are kept for review (possible implementation/specification conflict) and mutation scoring was skipped.',
      );
      partial = true;
      return report;
    }
    if (signature(cRuns[0]) !== signature(cRuns[1])) throw new TestForgeError('unstable', 'Tests gave different results on two runs against the original code; scoring stopped.');
    const allIds = new Set(cRuns[0].tests.map((t) => id(t.file, t.title)));

    // Stage 7-8: bounded mutation set, both suites against the same mutations
    stage('checking-mutations', 'Checking which code changes the tests detect');
    const sf = a.target.node.getSourceFile();
    const pristine = sf.text;
    const all = enumerateMutations(sf, a.target.node, report.sourceFile, report.inputHashes[report.sourceFile]);
    const n = Math.max(1, Math.min(input.mutationSample ?? LIMITS.defaultMutations, LIMITS.maxMutations));
    if (!all.length) report.limitations.push('No supported mutation opportunities.');
    else report.limitations.push(`Mutation results cover a sample of ${Math.min(n, all.length)} of ${all.length} supported mutations (hypothetical faults, not confirmed bugs).`);
    report.mutations = all.slice(0, n).map((m) => ({ ...m, detectingTests: [] }));
    for (const [i, m] of report.mutations.entries()) {
      if (sig.aborted) {
        m.baseline = baselineIds.size ? 'not-run' : undefined;
        m.generated = 'not-run';
        continue;
      }
      input.onStage?.('checking-mutations', `Mutation ${i + 1}/${report.mutations.length}: ${m.original} → ${m.replacement}`);
      writeFile(copy, report.sourceFile, applyMutation(pristine, m));
      const mtc = await typeCheck(tools, copy, run.tmp, sig);
      if (mtc.cancelled) {
        m.generated = 'not-run';
        m.baseline = baselineIds.size ? 'not-run' : undefined;
        continue;
      }
      if (!mtc.ok) {
        m.generated = mtc.timedOut ? 'timeout' : 'invalid';
        m.baseline = baselineIds.size ? m.generated : undefined;
        continue;
      }
      const r = await runVitest(tools, copy, run.tmp, allTests, sig);
      const b = classify(r, allIds);
      m.generated = b.outcome;
      m.detectingTests = b.detecting;
      m.note = b.note;
      if (baselineIds.size) m.baseline = classify(r, baselineIds).outcome;
    }
    writeFile(copy, report.sourceFile, pristine);
    if (sig.aborted) {
      const reason = sig.reason as TestForgeError;
      if (reason.kind === 'cancelled') throw reason;
      report.limitations.push(reason.message);
      partial = true;
    }
    report.scores.generated = score(report.mutations.map((m) => m.generated));
    if (baselineIds.size) {
      report.scores.baseline = score(report.mutations.map((m) => m.baseline));
      report.scores.comparison = compare(report.mutations);
    }

    // Stage 9: improvement pass (placeholder, see docs/plan.md §2)
    stage('improving', 'Improvement pass');
    if (report.mutations.some((m) => m.generated === 'survived')) {
      report.limitations.push('Some mutations survived. The follow-up improvement request is a placeholder in this release.');
    }
    return report;
  } catch (e) {
    const err = e instanceof TestForgeError ? e : sig.aborted && sig.reason instanceof TestForgeError ? sig.reason : new TestForgeError('infrastructure', `Unexpected error: ${(e as Error).message}`, (e as Error).stack);
    report.failure = { kind: err.kind, message: err.message, detail: err.detail };
    report.status = STATUS_FOR[err.kind];
    return report;
  } finally {
    clearTimeout(deadline);
    input.signal?.removeEventListener('abort', onUserAbort);
    if (!report.failure) report.status = partial ? 'partial' : 'completed';
    stage('reporting', 'Cleaning up');
    try {
      report.cleanup = !run || removeRunDir(run.root) ? 'done' : 'failed';
    } catch {
      report.cleanup = 'failed';
    }
    if (report.status === 'completed') report.stage = 'completed';
    report.finishedAt = new Date().toISOString();
  }
}

/** Recomputes hashes of a report's inputs to detect stale results. */
export function currentHashes(root: string, rels: string[], read: (abs: string) => Buffer | undefined): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const rel of rels) {
    const buf = read(path.join(root, rel));
    out[rel] = buf ? sha256(buf) : undefined;
  }
  return out;
}
