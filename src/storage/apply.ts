// Guarded application of a generated test file, freshness checks and bounded history.
// vscode-free: callers pass in dirty-buffer information.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { adjacentTestNames } from '../analysis/analyze';
import { LIMITS, RunReport } from '../core/types';
import { sha256 } from '../core/util';

export interface StoredRun {
  report: RunReport;
  root: string; // workspace folder fsPath
  savedAt: number;
  appliedHash?: string;
}

/** Keeps the newest runs within the count and age limits. */
export function pruneHistory(runs: StoredRun[], now = Date.now()): StoredRun[] {
  const maxAge = LIMITS.historyDays * 24 * 3600_000;
  return runs
    .filter((r) => now - r.savedAt <= maxAge)
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(0, LIMITS.historyRuns);
}

/** Reasons the report no longer matches the workspace. Empty means fresh. */
export function staleReasons(run: StoredRun, dirtyPaths: string[]): string[] {
  const reasons: string[] = [];
  const { report, root } = run;
  for (const [rel, hash] of Object.entries(report.inputHashes)) {
    const abs = path.join(root, rel);
    let current: string | undefined;
    try {
      current = sha256(fs.readFileSync(abs));
    } catch {
      current = undefined;
    }
    if (current !== hash) reasons.push(current ? `${rel} changed` : `${rel} was removed`);
  }
  const dirty = new Set(dirtyPaths.map((p) => path.resolve(p)));
  for (const rel of Object.keys(report.inputHashes)) if (dirty.has(path.resolve(root, rel))) reasons.push(`${rel} has unsaved changes`);
  try {
    const sourceAbs = path.join(root, report.sourceFile);
    const generated = report.generatedTestPath ? path.resolve(root, report.generatedTestPath) : '';
    for (const t of adjacentTestNames(sourceAbs)) {
      const rel = path.relative(root, t).split(path.sep).join('/');
      if (!report.baselineTests.includes(rel) && path.resolve(t) !== generated) reasons.push(`new test file ${rel}`);
    }
  } catch {
    reasons.push(`${report.sourceFile} is no longer readable`);
  }
  return reasons;
}

export type ApplyResult = { kind: 'created' | 'already-applied'; abs: string; hash: string };

/**
 * Creates the generated test file next to the module with exclusive create.
 * Never overwrites; re-applying the same run is idempotent.
 */
export function applyGenerated(run: StoredRun, opts: { allowFailing: boolean }): ApplyResult {
  const { report, root } = run;
  if (!report.generatedTest || !report.generatedTestPath) throw new Error('This run has no generated test file to apply.');
  if (report.failure) throw new Error(`This run ended as ${report.status} (${report.failure.message}); its tests cannot be applied.`);
  const failing = report.cases.filter((c) => c.status === 'accepted' && c.originalOutcome !== 'passed');
  if (failing.length && !opts.allowFailing) {
    throw new Error(`${failing.length} generated case(s) do not pass against the current code. Use "Apply Failing Candidate" to apply them anyway.`);
  }
  const abs = path.resolve(root, report.generatedTestPath);
  const realRoot = fs.realpathSync(root);
  const parent = fs.realpathSync(path.dirname(abs));
  const relParent = path.relative(realRoot, parent);
  if (relParent.startsWith('..') || path.isAbsolute(relParent)) throw new Error('The target folder resolves outside the workspace.');
  const hash = sha256(report.generatedTest);
  if (fs.existsSync(abs) || run.appliedHash) {
    let existing: string | undefined;
    try {
      if (fs.lstatSync(abs).isSymbolicLink()) throw new Error(`${report.generatedTestPath} is a symlink; TestForge will not write through it.`);
      existing = sha256(fs.readFileSync(abs));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (existing === hash) return { kind: 'already-applied', abs, hash };
    if (existing === undefined) throw new Error(`${report.generatedTestPath} was applied earlier and has since been removed. Run Generate & Verify again to create a new file.`);
    throw new Error(`${report.generatedTestPath} already exists with different content. TestForge never overwrites files.`);
  }
  fs.writeFileSync(abs, report.generatedTest, { flag: 'wx' });
  return { kind: 'created', abs, hash };
}
