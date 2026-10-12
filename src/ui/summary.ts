// Status words shared by the Results view, and the plain-text run summary returned by the
// chat tools. vscode-free, so unit tests can check the wording.
import type { CaseRecord, MutationOutcome, MutationRecord, RunReport, SuiteScore } from '../core/types';

export const WORD: Record<MutationOutcome, string> = { killed: 'DETECTED', survived: 'MISSED', invalid: 'INVALID', timeout: 'TIMEOUT', error: 'ERROR', 'not-run': 'NOT RUN' };

export const caseWord = (c: CaseRecord) =>
  c.status !== 'accepted' ? c.status.toUpperCase() : c.originalOutcome === 'passed' ? 'PASS' : c.originalOutcome === 'failed' ? 'FAIL' : c.originalOutcome === 'timeout' ? 'TIMEOUT' : 'NOT RUN';

export const fmtScore = (s?: SuiteScore) => (!s ? 'n/a' : s.rate === null ? `N/A (0 valid, ${s.excluded} excluded)` : `${s.killed}/${s.killed + s.survived} detected${s.excluded ? `, ${s.excluded} excluded` : ''}`);

const change = (m: MutationRecord) => `line ${m.line}: ${m.original} → ${m.replacement || '(removed)'}`;

/** Drops Vitest's internal stack frames and maps paths in the temporary copy back to project-relative ones. */
const tidy = (detail: string) =>
  detail
    .split('\n')
    .filter((l) => !/^\s*at .*(node_modules|node:internal|<anonymous>)/.test(l))
    .join('\n')
    .replace(/[^\s(]*[\\/]testforge-run-[^\\/\s]+[\\/]original[\\/]/g, '')
    .slice(0, 2000);

/**
 * Text for a chat tool result: status, cases, scores, every surviving mutation and the next step.
 * Audit reports are scored on the existing tests, generate reports on the generated suite.
 */
export function summarize(r: RunReport): string {
  const audit = r.mode === 'audit';
  const lines = [`TestForge ${audit ? 'audit' : 'Generate & Verify'} of ${r.exportName} in ${r.sourceFile}: ${r.status.toUpperCase()}. ${audit ? 'No AI model was used and no file was changed.' : `Model: ${r.model}.`}`];
  if (r.failure) lines.push(r.failure.message);
  if (r.failure?.detail) lines.push(`Details:\n${tidy(r.failure.detail)}`);
  if (r.baselineTests.length) lines.push(`Existing tests: ${r.baselineTests.join(', ')}`);

  const accepted = r.cases.filter((c) => c.status === 'accepted');
  if (accepted.length) {
    lines.push('Generated cases, run against the current code:');
    for (const c of accepted) lines.push(`- ${caseWord(c)}: ${c.title} [${c.basis}]${c.originalOutcome !== 'passed' && c.failureMessage ? ` (${c.failureMessage.split('\n')[0].slice(0, 200)})` : ''}`);
    if (accepted.some((c) => c.originalOutcome !== 'passed')) lines.push('A case that does not PASS fails against the current code: it may reveal a bug or a wrong expectation.');
  }
  if (r.cases.length > accepted.length) lines.push(`${r.cases.length - accepted.length} other proposed case(s) were rejected or duplicates (see the TestForge Results view).`);

  const s = r.scores;
  if (s.baseline) lines.push(`Mutation score of the existing tests: ${fmtScore(s.baseline)}.`);
  if (s.generated) lines.push(`Mutation score with the generated tests: ${fmtScore(s.generated)}.`);
  if (s.comparison) {
    const c = s.comparison;
    lines.push(`Before/after on the same ${c.denominator} mutation(s): ${c.before}/${c.denominator} → ${c.after}/${c.denominator} (${c.after - c.before >= 0 ? '+' : ''}${c.after - c.before}).`);
  }
  if (r.improvement) {
    const i = r.improvement;
    lines.push(`Improvement pass: ${i.killed}/${i.survivorsBefore} missed change(s) now detected (${i.added} case(s) added of ${i.proposed} proposed).`);
  }

  const outcome = (m: MutationRecord) => (audit ? m.baseline : m.generated);
  const survivors = r.mutations.filter((m) => outcome(m) === 'survived');
  if (survivors.length) lines.push('Surviving mutations (no test fails when the code is changed this way):', ...survivors.map((m) => `- ${change(m)}`));
  const detected = r.mutations.filter((m) => outcome(m) === 'killed');
  if (audit && detected.length) lines.push('Detected mutations:', ...detected.map((m) => `- ${change(m)} (by: ${m.detectingTests.join('; ')})`));
  const excluded = r.mutations.filter((m) => outcome(m) !== 'killed' && outcome(m) !== 'survived');
  if (excluded.length) lines.push('Not scored:', ...excluded.map((m) => `- ${change(m)}: ${WORD[outcome(m) ?? 'not-run']}${m.note ? ` (${m.note.slice(0, 200)})` : ''}`));
  for (const l of r.limitations) lines.push(`Note: ${l}`);

  if (audit && survivors.length) {
    lines.push(
      `Next step: add test cases to ${r.sourceFile.replace(/\.ts$/, '.test.ts')} that fail under each surviving mutation (often a boundary value), then call this tool again to re-check. ` +
        'An equivalent mutation (same behavior as the original) cannot be detected by any test. ' +
        'Write plain test() or it() calls with string titles and expect(); TestForge cannot run .each/.only/.skip, hooks, vi or snapshots.',
    );
  }
  if (!audit && r.generatedTest) {
    const failing = accepted.some((c) => c.originalOutcome !== 'passed');
    lines.push(
      `The generated tests are NOT applied: nothing was written to the workspace. The user can review them in the TestForge Results view and create ${r.generatedTestPath} ` +
        `with the command "TestForge: Apply Tests"${failing ? ' ("TestForge: Apply Failing Candidate" keeps failing cases)' : ''}.`,
    );
  }
  return lines.join('\n');
}
