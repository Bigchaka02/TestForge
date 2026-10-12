// "Test proof" as GitHub-flavored Markdown, for pull request descriptions and reviews.
// vscode-free. Every number comes from the report; text from the model or the source is escaped.
import type { MutationOutcome, RunReport, SuiteScore } from '../core/types';

const WORD: Record<MutationOutcome, string> = { killed: 'detected', survived: '**missed**', invalid: 'invalid', timeout: 'timeout', error: 'error', 'not-run': 'not run' };

// Control, invisible and bidi characters: they can hide or reorder text in a review (Trojan Source).
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]+/g;

/** Plain text safe in a Markdown table cell or list item: one line, no HTML, no table breaks. */
export const mdText = (s: string, max = 200) =>
  s
    .replace(HIDDEN, ' ')
    .slice(0, max)
    .replace(/[\\`*_[\]<>|#~!]/g, (c) => `\\${c}`);

/** Inline code span that survives backticks and pipes inside table cells. */
export function mdCode(s: string): string {
  if (!s) return '(removed)';
  const one = s.replace(HIDDEN, ' ').replace(/\|/g, '\\|');
  const longest = Math.max(0, ...(one.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  const pad = one.startsWith('`') || one.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${one}${pad}${fence}`;
}

const ratio = (s?: SuiteScore) => (!s ? 'n/a' : s.rate === null ? 'N/A (no valid mutations)' : `${s.killed} / ${s.killed + s.survived}`);

/** `stale`: why the run may no longer match the code (relative paths, from staleReasons). */
export function proofMarkdown(report: RunReport, stale: string[] = []): string {
  const r = report;
  const auditOnly = r.mode === 'audit';
  const out: string[] = [];
  out.push(`### TestForge proof: ${mdCode(r.exportName)} in ${mdCode(r.sourceFile)}`);
  if (r.demo) out.push('', '> DEMO run: cases came from a deterministic fake model, not an AI model.');
  if (auditOnly) out.push('', '> Audit of the existing tests: no AI model and no generated tests.');
  if (stale.length) out.push('', `> STALE: ${stale.map((s) => mdText(s, 120)).join('; ')}. These results may not match the current code.`);
  out.push('');

  if (r.failure) {
    out.push(`Run ended **${r.status.toUpperCase()}**: ${mdText(r.failure.message, 400)}`);
  } else if (r.mutations.length || r.scores.generated || r.scores.baseline) {
    out.push('| Suite | Hypothetical bugs detected |', '|---|---|');
    if (r.scores.baseline) out.push(`| Existing tests | ${ratio(r.scores.baseline)} |`);
    if (!auditOnly) out.push(`| ${r.scores.baseline ? 'With TestForge tests' : 'TestForge tests'} | ${ratio(r.scores.generated)} |`);
    const c = r.scores.comparison;
    if (c && c.denominator) out.push('', `On the same ${c.denominator} mutation(s): **${c.before} → ${c.after}** detected.`);
  } else {
    out.push(`Run ended **${r.status.toUpperCase()}** without mutation results.`);
  }

  const accepted = r.cases.filter((c) => c.status === 'accepted');
  const facts: string[] = [];
  if (!auditOnly) {
    const documented = accepted.filter((c) => c.basis !== 'inferred').length;
    const failing = accepted.filter((c) => c.originalOutcome !== 'passed').length;
    facts.push(`Cases: ${accepted.length} accepted (${documented} backed by docs or existing tests, ${accepted.length - documented} inferred), ${failing} failing against the current code`);
  }
  if (r.improvement) facts.push(`Improvement pass: ${r.improvement.killed} of ${r.improvement.survivorsBefore} missed change(s) now detected, ${r.improvement.added} case(s) added`);
  facts.push(`Model: ${mdText(r.model, 120)} · ${r.modelRequests} request(s) · run ${mdText(r.runId, 40)} · ${r.startedAt.slice(0, 10)}`);
  out.push('', ...facts.map((f) => `- ${f}`));

  const bugs = accepted.filter((c) => c.basis !== 'inferred' && c.originalOutcome === 'failed');
  if (bugs.length) {
    out.push('', '**Possible bugs** (the documentation or existing tests back the expectation, but the code disagrees):');
    for (const c of bugs) out.push(`- ${mdText(c.title)}${c.failureMessage ? `: ${mdText(c.failureMessage.split('\n')[0], 160)}` : ''}`);
  }

  if (r.mutations.length) {
    out.push('', '<details><summary>Mutation results</summary>', '');
    out.push(auditOnly ? '| Line | Change | Existing tests |' : r.scores.baseline ? '| Line | Change | Existing tests | With TestForge tests |' : '| Line | Change | TestForge tests |');
    out.push(auditOnly || !r.scores.baseline ? '|---|---|---|' : '|---|---|---|---|');
    for (const m of r.mutations) {
      const change = `${mdCode(m.original)} → ${mdCode(m.replacement)}`;
      const base = m.baseline ? WORD[m.baseline] : 'n/a';
      const gen = m.generated ? WORD[m.generated] : 'n/a';
      out.push(auditOnly ? `| ${m.line} | ${change} | ${base} |` : r.scores.baseline ? `| ${m.line} | ${change} | ${base} | ${gen} |` : `| ${m.line} | ${change} | ${gen} |`);
    }
    out.push('', '</details>');
  }

  out.push('', '_Mutations are small hypothetical code changes, not confirmed bugs. Scores come from real tsc and Vitest runs. Generated by TestForge._');
  return out.join('\n') + '\n';
}
