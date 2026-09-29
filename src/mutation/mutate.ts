// Small AST mutation engine: three operator families, inside the selected function
// body only, one mutation at a time on pristine text.
import ts from 'typescript';
import { Mutation, MutationOutcome, MutationRecord, SuiteRun, SuiteScore, Comparison } from '../core/types';
import { sha256 } from '../core/util';

const RELATIONAL: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.GreaterThanEqualsToken]: '>',
  [ts.SyntaxKind.GreaterThanToken]: '>=',
  [ts.SyntaxKind.LessThanEqualsToken]: '<',
  [ts.SyntaxKind.LessThanToken]: '<=',
};
const EQUALITY: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: '!==',
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: '===',
};

const isNestedFunction = (n: ts.Node) =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isClassLike(n) || ts.isAccessor(n);

/** Enumerates mutations inside `fn` (an exported function or arrow), sorted by position. */
export function enumerateMutations(sf: ts.SourceFile, fn: ts.Node, rel: string, fileHash: string): Mutation[] {
  const out: Mutation[] = [];
  const add = (family: Mutation['family'], node: ts.Node, replacement: string) => {
    const start = node.getStart(sf);
    const end = node.getEnd();
    const original = sf.text.slice(start, end);
    const pos = sf.getLineAndCharacterOfPosition(start);
    const id = `m-${sha256(`${fileHash}:${start}:${end}:${original}:${replacement}`).slice(0, 10)}`;
    out.push({ id, family, file: rel, start, end, line: pos.line + 1, column: pos.character + 1, original, replacement });
  };
  const visit = (n: ts.Node) => {
    if (n !== fn && isNestedFunction(n)) return; // skip nested function bodies
    if (ts.isTypeNode(n)) return; // no mutations inside types
    if (ts.isBinaryExpression(n)) {
      const k = n.operatorToken.kind;
      if (RELATIONAL[k]) add('relational-boundary', n.operatorToken, RELATIONAL[k]!);
      if (EQUALITY[k]) add('strict-equality', n.operatorToken, EQUALITY[k]!);
    }
    if (ts.isReturnStatement(n) && n.expression) {
      if (n.expression.kind === ts.SyntaxKind.TrueKeyword) add('boolean-return', n.expression, 'false');
      if (n.expression.kind === ts.SyntaxKind.FalseKeyword) add('boolean-return', n.expression, 'true');
    }
    ts.forEachChild(n, visit);
  };
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
    const k = fn.body.kind;
    if (k === ts.SyntaxKind.TrueKeyword) add('boolean-return', fn.body, 'false');
    if (k === ts.SyntaxKind.FalseKeyword) add('boolean-return', fn.body, 'true');
  }
  const body = (fn as ts.FunctionLikeDeclaration).body;
  if (body) visit(body);
  return out.sort((a, b) => a.start - b.start || a.replacement.localeCompare(b.replacement));
}

/** Applies one mutation to pristine text after verifying the original token. */
export function applyMutation(text: string, m: Mutation): string {
  if (text.slice(m.start, m.end) !== m.original) throw new Error(`mutation ${m.id}: original token not found at ${m.line}:${m.column}`);
  return text.slice(0, m.start) + m.replacement + text.slice(m.end);
}

/**
 * Classifies one suite's outcome for a mutant run.
 * `suiteTests` are the test identities (file::title) of the suite that passed on original code.
 */
export function classify(run: SuiteRun, suiteTests: Set<string>): { outcome: MutationOutcome; detecting: string[]; note?: string } {
  if (run.status === 'cancelled') return { outcome: 'not-run', detecting: [] };
  const mine = run.tests.filter((t) => suiteTests.has(`${t.file}::${t.title}`));
  if (run.status === 'timeout' || mine.some((t) => t.timedOut)) return { outcome: 'timeout', detecting: [], note: run.error };
  if (run.status === 'error') return { outcome: 'error', detecting: [], note: run.error };
  if (mine.length !== suiteTests.size) return { outcome: 'error', detecting: [], note: 'test identities differ from the original run' };
  const failed = mine.filter((t) => t.status === 'failed');
  if (failed.length) return { outcome: 'killed', detecting: failed.map((t) => t.title) };
  return { outcome: 'survived', detecting: [] };
}

export function score(outcomes: (MutationOutcome | undefined)[]): SuiteScore {
  const killed = outcomes.filter((o) => o === 'killed').length;
  const survived = outcomes.filter((o) => o === 'survived').length;
  const excluded = outcomes.filter((o) => o !== undefined).length - killed - survived;
  return { killed, survived, excluded, rate: killed + survived > 0 ? killed / (killed + survived) : null };
}

const valid = (o?: MutationOutcome) => o === 'killed' || o === 'survived';

/** Before/after on the shared set of mutations valid for both suites. */
export function compare(records: MutationRecord[]): Comparison {
  const shared = records.filter((r) => valid(r.baseline) && valid(r.generated));
  return {
    denominator: shared.length,
    before: shared.filter((r) => r.baseline === 'killed').length,
    after: shared.filter((r) => r.generated === 'killed').length,
    excluded: records.length - shared.length,
  };
}
