// What a run means for the code in the editor: per-line mutation markers with hover text, a
// one-line score summary and "possible bug" findings. vscode-free (D5). Report values are
// untrusted (titles and messages can come from a model), so they are escaped in Markdown.
import { findExports, parse } from '../analysis/analyze';
import type { CaseRecord, MutationOutcome, MutationRecord, RunReport } from '../core/types';
import { visible } from './markdown';

export interface LineInsight {
  line: number; // 1-based line in report.sourceFile
  state: 'protected' | 'exposed'; // every valid mutation detected / at least one missed
  hover: string; // Markdown
}

export interface PossibleBug {
  caseId: string;
  message: string; // plain text
  evidence?: { file: string; line: number; excerpt: string }; // relative path, 1-based line
}

const WORD: Record<MutationOutcome, string> = { killed: 'DETECTED', survived: 'MISSED', invalid: 'INVALID', timeout: 'TIMEOUT', error: 'ERROR', 'not-run': 'NOT RUN' };

/** Display text on one line: whitespace, control, invisible and bidi characters collapse to one space; long text is cut. */
const oneLine = (s: string, max = 300): string => {
  const t = visible(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Untrusted text as literal Markdown: one line, every ASCII punctuation character backslash-escaped. */
export const escapeMarkdown = (s: string): string => oneLine(s).replace(/[!-/:-@[-`{-~]/g, '\\$&');

/** Untrusted text as an inline code span, fenced by more backticks than it contains. */
function code(s: string): string {
  const t = oneLine(s, 80);
  const fence = '`'.repeat(Math.max(0, ...(t.match(/`+/g) ?? []).map((r) => r.length)) + 1);
  const pad = t.startsWith('`') || t.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${t}${pad}${fence}`;
}

/** Outcome under the final suite: with the generated tests when they ran, otherwise the existing tests. */
const final = (m: MutationRecord): MutationOutcome | undefined => m.generated ?? m.baseline;

function hover(report: RunReport, list: MutationRecord[], valid: number, missed: number): string {
  const generated = list.some((m) => m.generated);
  const head = missed
    ? `exposed: ${missed} of ${valid} checked changes on this line go undetected ${generated ? 'even with the generated tests' : 'by the existing tests'}`
    : `protected: every checked change on this line is detected ${generated ? 'with the generated tests' : 'by the existing tests'}`;
  const items = list.map((m) => {
    const outcomes = [m.baseline && `existing tests ${WORD[m.baseline]}`, m.generated && `with generated tests ${WORD[m.generated]}`].filter(Boolean).join(' · ') || 'not checked';
    const by = final(m) === 'killed' ? m.detectingTests : [];
    const titles = by.slice(0, 3).map((t) => `"${escapeMarkdown(t)}"`).join(', ') + (by.length > 3 ? ` and ${by.length - 3} more` : '');
    return `- ${code(m.original)} → ${m.replacement ? code(m.replacement) : '(removed)'}: ${outcomes}${by.length ? `\n  - detected by ${titles}` : ''}`;
  });
  return [`**TestForge**${report.demo ? ' (DEMO)' : ''} · ${head}`, '', ...items, '', `_Mutations are hypothetical changes, not confirmed bugs (run ${escapeMarkdown(report.runId)})._`].join('\n');
}

/** Markers for report.sourceFile: lines whose mutations are all invalid, timed out, errored or not run get none. */
export function lineInsights(report: RunReport): LineInsight[] {
  const byLine = new Map<number, MutationRecord[]>();
  for (const m of report.mutations) if (m.file === report.sourceFile) byLine.set(m.line, [...(byLine.get(m.line) ?? []), m]);
  const out: LineInsight[] = [];
  for (const [line, list] of [...byLine].sort((a, b) => a[0] - b[0])) {
    const valid = list.filter((m) => final(m) === 'killed' || final(m) === 'survived');
    if (!valid.length) continue;
    const missed = valid.filter((m) => final(m) === 'survived').length;
    out.push({ line, state: missed ? 'exposed' : 'protected', hover: hover(report, list, valid.length, missed) });
  }
  return out;
}

/**
 * One line for a CodeLens, built only from the report's scores. Undefined when nothing was scored.
 * A run that did not complete, and mutations that were excluded or not run, are named next to the score.
 */
export function scoreSummary(report: RunReport): string | undefined {
  const { baseline, generated, comparison } = report.scores;
  const notes = (excluded: number) => {
    const parts = [report.status !== 'completed' && report.status.toUpperCase(), excluded > 0 && `${excluded} excluded or not run`, report.demo && 'DEMO'].filter(Boolean);
    return parts.length ? ` (${parts.join(', ')})` : '';
  };
  if (comparison?.denominator) return `TestForge: existing tests catch ${comparison.before}/${comparison.denominator} changes → ${comparison.after}/${comparison.denominator} with generated tests${notes(comparison.excluded)}`;
  const s = generated ?? baseline;
  if (!s || s.rate === null) return undefined;
  return `TestForge: tests catch ${s.killed}/${s.killed + s.survived} changes${generated ? ' with generated tests' : ''}${notes(s.excluded)}`;
}

const BACKED_BY: Partial<Record<CaseRecord['basis'], string>> = { documented: 'is documented', 'existing-test': 'follows from an existing test' };

/**
 * Accepted cases whose documentation or existing tests back the expectation but which fail
 * against the code. Inferred failing cases are left out: they may be model mistakes.
 */
export function possibleBugs(report: RunReport): PossibleBug[] {
  return report.cases
    .filter((c) => c.status === 'accepted' && c.originalOutcome === 'failed' && BACKED_BY[c.basis])
    .map((c) => {
      const ev = c.evidence[0];
      const n = ev && /^F(\d+)$/.exec(ev.fileId);
      const file = n ? report.contextFiles[Number(n[1]) - 1] : undefined;
      const evidence = ev && file ? { file, line: ev.startLine, excerpt: oneLine(ev.excerpt) } : undefined;
      const why = c.failureMessage?.split(/\r?\n/).find((l) => l.trim());
      const where = evidence ? ` (${evidence.file}:${evidence.line})` : '';
      const message = `Possible bug${report.demo ? ' (DEMO)' : ''}: "${oneLine(c.title, 200)}" ${BACKED_BY[c.basis]}${where} but fails against the code${why ? `: ${oneLine(why)}` : '.'}`;
      return { caseId: c.id, message, evidence };
    });
}

/** 1-based declaration line of the run's target function in `text`, if it is still there. */
export const targetLine = (report: RunReport, text: string): number | undefined =>
  findExports(parse(report.sourceFile, text)).find((e) => e.name === report.exportName)?.line;
