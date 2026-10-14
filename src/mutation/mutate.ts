// Small AST mutation engine: eight operator families, inside the selected function
// body only, one mutation at a time on pristine text.
import ts from 'typescript';
import { Mutation, MutationOutcome, MutationRecord, SuiteRun, SuiteScore, Comparison, TestStatus } from '../core/types';
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

const ARITHMETIC: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.PlusToken]: '-',
  [ts.SyntaxKind.MinusToken]: '+',
  [ts.SyntaxKind.AsteriskToken]: '/',
  [ts.SyntaxKind.SlashToken]: '*',
  [ts.SyntaxKind.PercentToken]: '*',
};
const LOGICAL: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.AmpersandAmpersandToken]: '||',
  [ts.SyntaxKind.BarBarToken]: '&&',
};
const isStringish = (n: ts.Node) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n);

const isNestedFunction = (n: ts.Node) =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isClassLike(n) || ts.isAccessor(n);

/** Enumerates mutations inside `fn` (an exported function or arrow), sorted by position. */
export function enumerateMutations(sf: ts.SourceFile, fn: ts.Node, rel: string, fileHash: string): Mutation[] {
  const out: Mutation[] = [];
  const addSpan = (family: Mutation['family'], start: number, end: number, replacement: string) => {
    const original = sf.text.slice(start, end);
    const pos = sf.getLineAndCharacterOfPosition(start);
    const id = `m-${sha256(`${fileHash}:${start}:${end}:${original}:${replacement}`).slice(0, 10)}`;
    out.push({ id, family, file: rel, start, end, line: pos.line + 1, column: pos.character + 1, original, replacement });
  };
  const add = (family: Mutation['family'], node: ts.Node, replacement: string) => addSpan(family, node.getStart(sf), node.getEnd(), replacement);
  const visit = (n: ts.Node) => {
    if (n !== fn && isNestedFunction(n)) return; // skip nested function bodies
    if (ts.isTypeNode(n)) return; // no mutations inside types
    if (ts.isBinaryExpression(n)) {
      const k = n.operatorToken.kind;
      if (RELATIONAL[k]) {
        add('relational-boundary', n.operatorToken, RELATIONAL[k]!);
        // Numeric bounds in a comparison: off-by-one in either direction.
        for (const side of [n.left, n.right]) {
          if (ts.isNumericLiteral(side) && /^\d+$/.test(side.text) && side.getText(sf) === side.text) {
            const v = Number(side.text);
            add('literal-boundary', side, String(v + 1));
            if (v > 0) add('literal-boundary', side, String(v - 1));
          }
        }
      }
      if (EQUALITY[k]) add('strict-equality', n.operatorToken, EQUALITY[k]!);
      // `+` on strings would only produce a compile error, so string concatenation is skipped.
      if (ARITHMETIC[k] && !(k === ts.SyntaxKind.PlusToken && (isStringish(n.left) || isStringish(n.right)))) {
        // `a+-b` must become `a- -b`, not `a--b`: a sign right after the new operator would merge with it.
        const merges = /[+-]/.test(ARITHMETIC[k]!) && /[+-]/.test(sf.text.charAt(n.operatorToken.getEnd()));
        add('arithmetic', n.operatorToken, merges ? `${ARITHMETIC[k]!} ` : ARITHMETIC[k]!);
      }
      if (LOGICAL[k]) add('logical', n.operatorToken, LOGICAL[k]!);
    }
    // In `!!x` only the inner `!` is removed: removing either one gives the same program.
    if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken && !(ts.isPrefixUnaryExpression(n.operand) && n.operand.operator === ts.SyntaxKind.ExclamationToken)) {
      const start = n.getStart(sf);
      addSpan('negation-removal', start, start + 1, '');
    }
    if (ts.isIfStatement(n) && n.expression.kind !== ts.SyntaxKind.TrueKeyword && n.expression.kind !== ts.SyntaxKind.FalseKeyword) {
      add('if-condition', n.expression, 'true');
      add('if-condition', n.expression, 'false');
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

/** Deterministic, evenly spread sample of at most `n` mutations (keeps source order). */
export function sampleMutations<T>(all: T[], n: number): T[] {
  if (all.length <= n) return all;
  return Array.from({ length: n }, (_, i) => all[Math.floor((i * all.length) / n)]);
}

/** Applies one mutation to pristine text after verifying the original token. */
export function applyMutation(text: string, m: Mutation): string {
  if (text.slice(m.start, m.end) !== m.original) throw new Error(`mutation ${m.id}: original token not found at ${m.line}:${m.column}`);
  return text.slice(0, m.start) + m.replacement + text.slice(m.end);
}

const TOKEN = /^(?:[<>=!+\-*/%&|]{1,3}|\d{1,12})$/;

/** Progress text for a mutation: family and line, plus the tokens only when both are a short operator or number, never other source text. */
export function describeMutation(m: Mutation): string {
  const [from, to] = [m.original, m.replacement.trim()];
  return `${m.family} on line ${m.line}${TOKEN.test(from) && TOKEN.test(to) ? `: ${from} → ${to}` : ''}`;
}

/**
 * Classifies one suite's outcome for a mutant run.
 * `suiteTests` maps the test identities (file::title) of the suite's run on the original code to
 * their status there. Only tests that passed on the original can detect a mutation: skipped and
 * todo tests never fail, and a test skipped there (ctx.skip() in a branch) proves nothing when it fails.
 * A per-test timeout in another suite does not hide this suite's result.
 */
export function classify(run: SuiteRun, suiteTests: Map<string, TestStatus>): { outcome: MutationOutcome; detecting: string[]; note?: string } {
  if (run.status === 'cancelled') return { outcome: 'not-run', detecting: [] };
  const mine = run.tests.filter((t) => suiteTests.has(`${t.file}::${t.title}`));
  if (mine.some((t) => t.timedOut) || (run.status === 'timeout' && !run.tests.length)) return { outcome: 'timeout', detecting: [], note: run.error };
  if (run.status === 'error') return { outcome: 'error', detecting: [], note: run.error };
  if (new Set(mine.map((t) => `${t.file}::${t.title}`)).size !== suiteTests.size) return { outcome: 'error', detecting: [], note: 'test identities differ from the original run' };
  const failed = mine.filter((t) => t.status === 'failed' && suiteTests.get(`${t.file}::${t.title}`) === 'passed');
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
