// Orchestrates one Generate & Verify run, or an audit of the existing tests (no model).
// vscode-free so it runs under Vitest.
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzeTarget, TargetAnalysis } from '../analysis/analyze';
import { buildPrompt, correctionPrompt, evidenceFiles, existingTitles } from '../generation/prompt';
import { readFingerprints, renderTests } from '../generation/render';
import { EvidenceFile, parseModelText, validatePlan, ValidationResult } from '../generation/validate';
import { resolveNode, resolveTools, runVitest, typeCheck } from '../execution/runner';
import { createCopy, createRunDir, removeRunDir, RunDir, writeConfigs, writeFile } from '../execution/workspace';
import { applyMutation, classify, compare, enumerateMutations, sampleMutations, score } from '../mutation/mutate';
import type { ModelProvider } from '../providers/provider';
import { CaseRecord, LIMITS, MutationRecord, RunReport, Stage, SuiteRun, TerminalStatus, TestForgeError } from './types';
import { newRunId, sha256 } from './util';

interface PipelineOptions {
  root: string;
  sourceAbs: string;
  exportName: string;
  nodePath?: string;
  mutationSample?: number;
  globalDeadlineMs?: number;
  signal?: AbortSignal;
  onStage?: (stage: Stage, message: string) => void;
  tmpBase?: string;
  /** Set false to skip the improvement request (default on). */
  improve?: boolean;
}

/** Generate (the default) asks `provider` for cases. Audit mutation-checks the existing tests with no model. */
export type RunMode = { mode?: 'generate'; provider: ModelProvider } | { mode: 'audit'; provider?: undefined };

export type PipelineInput = PipelineOptions & RunMode;

const id = (file: string, title: string) => `${file}::${title}`;
const signature = (r: SuiteRun) => r.tests.map((t) => `${id(t.file, t.title)}=${t.status}`).sort().join('\n');

/** True when two runs of the same suite produced the same tests with the same outcomes (order-insensitive). */
export const sameResults = (a: SuiteRun, b: SuiteRun) => signature(a) === signature(b);

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

/**
 * Preflight shared with the editor: `analyzeTarget`'s support matrix, plus existing tests for an audit.
 * Throws TestForgeError with a precise reason.
 */
export function preflight(root: string, sourceAbs: string, exportName: string, mode: RunMode['mode']): TargetAnalysis {
  const a = analyzeTarget(root, sourceAbs, exportName);
  if (mode === 'audit' && !a.baselineTests.length) {
    throw new TestForgeError('unsupported', `No existing tests of ${a.sourceRel} were found to audit (next to it, in __tests__/, or under test/ or tests/). Add ${a.sourceRel.replace(/\.ts$/, '.test.ts')} or use Generate & Verify Tests.`);
  }
  return a;
}

export async function runPipeline(input: PipelineInput): Promise<RunReport> {
  const runId = newRunId();
  const audit = input.mode === 'audit';
  const report: RunReport = {
    schemaVersion: 1,
    runId,
    mode: audit ? 'audit' : 'generate',
    status: 'failed',
    stage: 'idle',
    demo: !!input.provider?.isFake,
    scope: 'selected-module test scope',
    exportName: input.exportName,
    sourceFile: path.relative(input.root, input.sourceAbs).split(path.sep).join('/'),
    inputHashes: {},
    model: input.provider?.label ?? 'none (audit only)',
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
  if (input.provider?.isFake) report.limitations.push('DEMO mode: cases come from a deterministic fake provider, not an AI model.');

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
  /** After a mutation loop: a cancel stops the run, a reached deadline keeps the results as partial. */
  const endMutations = () => {
    if (!sig.aborted) return;
    const reason = sig.reason as TestForgeError;
    if (reason.kind === 'cancelled') throw reason;
    report.limitations.push(reason.message);
    partial = true;
  };
  try {
    // Stage 1-2: preflight and freeze inputs
    stage('preflight', 'Checking project support');
    const a = preflight(input.root, input.sourceAbs, input.exportName, input.mode);
    report.toolVersions = { ...a.toolVersions };
    report.baselineTests = a.baselineTests;
    if (!audit) report.contextFiles = a.files.map((f) => f.rel); // an audit sends nothing
    report.contextExclusions = a.exclusions;
    for (const f of a.files) report.inputHashes[f.rel] = f.hash;
    Object.assign(report.inputHashes, a.packageHashes);

    stage('snapshotting', 'Copying files to a temporary run directory');
    run = createRunDir(runId, input.tmpBase ?? os.tmpdir());
    const node = await resolveNode(input.nodePath, run.tmp);
    report.toolVersions.node = node.version;
    const tools = resolveTools(input.root, node.path);
    const sources = a.files.filter((f) => f.role === 'source').map((f) => f.rel);
    const copy = createCopy(run, 'original', input.root, a.files, a.baselineTests, a.types);

    // Stage 3: original must type-check
    const tc = await typeCheck(tools, copy, run.tmp, sig);
    checkAbort();
    if (!tc.ok) {
      const why = audit ? 'The original code and its existing tests do not type-check, so TestForge stopped before running them.' : 'The original code does not type-check, so TestForge stopped before generating tests.';
      throw new TestForgeError('original-type-error', tc.timedOut ? 'Type checking the original project timed out.' : why, tc.output);
    }

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
      if (!sameResults(runs[0], runs[1])) throw new TestForgeError('unstable', 'Existing tests gave different results on two runs; scoring stopped.');
      baselineIds = new Set(runs[0].tests.map((t) => id(t.file, t.title)));
    } else {
      report.limitations.push('No existing tests of the module were found (next to it, in __tests__/, or under test/ or tests/), so there is no before/after comparison.');
    }

    // Audit: no model request and no generated file. Each sampled mutant faces the existing tests alone.
    if (input.mode === 'audit') {
      stage('checking-mutations', 'Checking which code changes the existing tests detect');
      const pristine = a.target.node.getSourceFile().text;
      report.mutations = sampleMutants(a, report, input.mutationSample);
      for (const [i, m] of report.mutations.entries()) {
        if (sig.aborted) {
          m.baseline = 'not-run';
          continue;
        }
        input.onStage?.('checking-mutations', `Mutation ${i + 1}/${report.mutations.length}: ${m.original} → ${m.replacement || '(removed)'}`);
        writeFile(copy, report.sourceFile, applyMutation(pristine, m));
        const mtc = await typeCheck(tools, copy, run.tmp, sig);
        if (!mtc.ok) {
          m.baseline = mtc.cancelled ? 'not-run' : mtc.timedOut ? 'timeout' : 'invalid';
          continue;
        }
        const b = classify(await runVitest(tools, copy, run.tmp, a.baselineTests, sig), baselineIds);
        Object.assign(m, { baseline: b.outcome, detectingTests: b.detecting, note: b.note });
      }
      endMutations();
      report.scores.baseline = score(report.mutations.map((m) => m.baseline));
      if (report.mutations.some((m) => m.baseline === 'survived')) report.limitations.push('Some mutations survive the existing tests: behavior the tests do not check, or equivalent changes.');
      return report;
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
    report.generatedTest = renderTests({ runId, exportName: a.exportName, importPath: `./${base}.js`, cases: accepted, demo: input.provider.isFake, isAsync: a.target.isAsync });

    // Stage 6: suite B (baseline + generated) against original code, twice
    stage('validating-candidates', 'Running generated tests against the original code');
    const allTests = [...a.baselineTests, genRel];
    writeFile(copy, genRel, report.generatedTest);
    writeConfigs(copy, sources, allTests, a.types);
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
    if (!sameResults(cRuns[0], cRuns[1])) throw new TestForgeError('unstable', 'Tests gave different results on two runs against the original code; scoring stopped.');
    const allIds = new Set(cRuns[0].tests.map((t) => id(t.file, t.title)));

    /**
     * Writes a new generated file into the copy and runs it twice against the original code.
     * Cases in `added` that do not pass are rejected; returns the new suite identities, or
     * undefined when the new file could not be verified (the caller restores the old one).
     */
    const verifyOnOriginal = async (src: string, added: CaseRecord[]): Promise<Set<string> | undefined> => {
      writeFile(copy, genRel, src);
      const tcx = await typeCheck(tools, copy, run!.tmp, sig);
      checkAbort();
      if (!tcx.ok) {
        for (const c of added) Object.assign(c, { status: 'rejected', rejectReason: 'the improved test file did not type-check' });
        return undefined;
      }
      const runs: SuiteRun[] = [];
      for (let i = 0; i < 2; i++) {
        const r = await runVitest(tools, copy, run!.tmp, allTests, sig);
        checkAbort();
        runs.push(r);
        if (r.status !== 'completed') break;
      }
      for (const c of added) {
        const t = runs[0].tests.find((x) => x.file === genRel && x.title.startsWith(`[${c.id}]`));
        c.originalOutcome = !t ? 'not-run' : t.timedOut ? 'timeout' : t.status === 'passed' ? 'passed' : 'failed';
        if (t?.message) c.failureMessage = t.message;
      }
      const ok = runs.length === 2 && runs.every((r) => r.status === 'completed') && sameResults(runs[0], runs[1]) && runs[0].tests.every((t) => t.status !== 'failed');
      if (ok) return new Set(runs[0].tests.map((t) => id(t.file, t.title)));
      for (const c of added) Object.assign(c, { status: 'rejected', rejectReason: c.originalOutcome === 'passed' ? 'dropped with the other improvement cases' : `${c.originalOutcome} against the original code in the improvement pass` });
      return undefined;
    };

    // Stage 7-8: bounded mutation set, both suites against the same mutations
    stage('checking-mutations', 'Checking which code changes the tests detect');
    const pristine = a.target.node.getSourceFile().text;
    report.mutations = sampleMutants(a, report, input.mutationSample);

    /** Runs each mutant against the current generated file. `generatedOnly` keeps baseline outcomes (re-checks after the improvement pass). */
    const checkMutants = async (list: MutationRecord[], suiteIds: Set<string>, generatedOnly: boolean) => {
      for (const [i, m] of list.entries()) {
        if (sig.aborted) {
          if (generatedOnly) break;
          m.baseline = baselineIds.size ? 'not-run' : undefined;
          m.generated = 'not-run';
          continue;
        }
        input.onStage?.('checking-mutations', `Mutation ${i + 1}/${list.length}: ${m.original} → ${m.replacement || '(removed)'}`);
        writeFile(copy, report.sourceFile, applyMutation(pristine, m));
        const mtc = await typeCheck(tools, copy, run!.tmp, sig);
        if (mtc.cancelled) {
          if (generatedOnly) break;
          m.generated = 'not-run';
          m.baseline = baselineIds.size ? 'not-run' : undefined;
          continue;
        }
        if (!mtc.ok) {
          m.generated = mtc.timedOut ? 'timeout' : 'invalid';
          if (!generatedOnly) m.baseline = baselineIds.size ? m.generated : undefined;
          continue;
        }
        const r = await runVitest(tools, copy, run!.tmp, allTests, sig);
        if (generatedOnly && r.status === 'cancelled') break;
        const b = classify(r, suiteIds);
        m.generated = b.outcome;
        m.detectingTests = b.detecting;
        m.note = b.note;
        if (!generatedOnly && baselineIds.size) m.baseline = classify(r, baselineIds).outcome;
      }
      writeFile(copy, report.sourceFile, pristine);
    };
    const scoreAll = () => {
      report.scores.generated = score(report.mutations.map((m) => m.generated));
      if (baselineIds.size) {
        report.scores.baseline = score(report.mutations.map((m) => m.baseline));
        report.scores.comparison = compare(report.mutations);
      }
    };

    await checkMutants(report.mutations, allIds, false);
    endMutations();
    scoreAll();

    // Stage 9: improvement pass. One extra request aimed at surviving mutants; new cases
    // must pass against the original code before survivors are re-checked.
    const survivors = report.mutations.filter((m) => m.generated === 'survived');
    if (survivors.length && !sig.aborted && input.improve !== false) {
      stage('improving', `Asking for cases that detect ${survivors.length} missed change(s)`);
      const imp = await improvementPass({ a, evFiles, known, accepted, survivors, report, provider: input.provider, sig });
      const render = (extra: CaseRecord[]) => renderTests({ runId, exportName: a.exportName, importPath: `./${base}.js`, cases: [...accepted, ...extra], demo: input.provider.isFake, isAsync: a.target.isAsync });
      let added = imp.added.filter((c) => c.status === 'accepted');
      let verified = added.length ? await verifyOnOriginal(render(added), added) : undefined;
      // One retry with only the cases that passed, so one wrong expectation does not discard the rest.
      const passing = added.filter((c) => c.originalOutcome === 'passed');
      if (!verified && passing.length && passing.length < added.length) {
        for (const c of passing) Object.assign(c, { status: 'accepted', rejectReason: undefined });
        added = passing;
        verified = await verifyOnOriginal(render(added), added);
      }
      if (verified) {
        report.generatedTest = render(added);
        await checkMutants(survivors, verified, true);
        checkAbort();
        scoreAll();
      } else if (added.length) {
        writeFile(copy, genRel, report.generatedTest);
      }
      const killed = survivors.filter((m) => m.generated === 'killed').length;
      report.improvement = { survivorsBefore: survivors.length, proposed: imp.proposed, added: verified ? added.length : 0, killed };
      if (imp.added.some((c) => c.status !== 'accepted' && c.originalOutcome && c.originalOutcome !== 'passed')) {
        report.limitations.push('Some improvement cases failed against the original code and were not added. They are listed under Cases: each may point at a bug or a wrong expectation.');
      }
      if (imp.note) report.limitations.push(imp.note);
      if (report.mutations.some((m) => m.generated === 'survived')) report.limitations.push('Some mutations still survive. They may be equivalent changes, or cases the documentation does not support.');
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

/** Enumerates the supported mutations in the target body and keeps an evenly spread sample (noted as a limitation). */
function sampleMutants(a: TargetAnalysis, report: RunReport, sample: number | undefined): MutationRecord[] {
  const all = enumerateMutations(a.target.node.getSourceFile(), a.target.node, report.sourceFile, report.inputHashes[report.sourceFile]);
  const n = Math.max(1, Math.min(sample ?? LIMITS.defaultMutations, LIMITS.maxMutations));
  if (!all.length) report.limitations.push('No supported mutation opportunities.');
  else report.limitations.push(`Mutation results cover a sample of ${Math.min(n, all.length)} of ${all.length} supported mutations (hypothetical faults, not confirmed bugs).`);
  return sampleMutations(all, n).map((m) => ({ ...m, detectingTests: [] }));
}

/**
 * Sends one request listing the surviving mutants and validates the reply. Never throws for
 * provider or validation problems: the earlier results stand and a note explains why.
 */
async function improvementPass(o: {
  a: TargetAnalysis;
  evFiles: EvidenceFile[];
  known: Set<string>;
  accepted: CaseRecord[];
  survivors: MutationRecord[];
  report: RunReport;
  provider: ModelProvider;
  sig: AbortSignal;
}): Promise<{ proposed: number; added: CaseRecord[]; note?: string }> {
  const { report, sig } = o;
  if (report.modelRequests >= LIMITS.maxModelRequests) return { proposed: 0, added: [], note: 'The improvement pass was skipped: the model request budget is used up.' };
  const prompt = buildPrompt(o.a, o.evFiles, {
    maxCases: LIMITS.improvementCases,
    existingTitles: [...existingTitles(o.a), ...o.accepted.map((c) => c.title)],
    survivors: o.survivors,
  });
  const reqCtrl = new AbortController();
  const reqTimer = setTimeout(() => reqCtrl.abort(), LIMITS.modelDeadlineMs);
  const onAbort = () => reqCtrl.abort();
  sig.addEventListener('abort', onAbort, { once: true });
  let text: string;
  try {
    report.modelRequests++;
    text = await o.provider.complete(prompt, [], reqCtrl.signal);
  } catch (e) {
    if (sig.aborted) throw sig.reason;
    return { proposed: 0, added: [], note: `The improvement request failed, so earlier results stand: ${(e as Error).message}` };
  } finally {
    clearTimeout(reqTimer);
    sig.removeEventListener('abort', onAbort);
  }
  if (sig.aborted) throw sig.reason;
  try {
    const known = new Set([...o.known, ...o.accepted.map((c) => c.fingerprint)]);
    const r = validatePlan(parseModelText(text), { exportName: o.a.exportName, files: o.evFiles, known, existing: o.accepted, maxAccepted: o.accepted.length + LIMITS.improvementCases });
    for (const c of r.cases) c.round = 'improvement';
    report.cases.push(...r.cases);
    report.duplicatesSkipped += r.duplicatesSkipped;
    return { proposed: r.plan.cases.length, added: r.cases.filter((c) => c.status === 'accepted') };
  } catch (e) {
    return { proposed: 0, added: [], note: `The improvement response was rejected, so earlier results stand: ${(e as Error).message}` };
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
