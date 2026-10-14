// Static analysis with the TypeScript parser: eligible exports, support checks,
// bounded relative import closure, baseline tests. Never executes project code.
import * as fs from 'node:fs';
import { isBuiltin } from 'node:module';
import * as path from 'node:path';
import ts from 'typescript';
import { LIMITS, TestForgeError } from '../core/types';
import { sha256 } from '../core/util';
import toolchain from '../../toolchain.json';

export interface ExportInfo {
  name: string;
  line: number; // 1-based line of the declaration
  eligible: boolean;
  isAsync: boolean;
  reason?: string; // why it is not eligible
  bodyStart: number;
  bodyEnd: number;
  node: ts.Node;
}

export interface ProjectFile {
  rel: string; // posix path relative to the project root
  text: string;
  hash: string;
  role: 'source' | 'test';
}

export interface TargetAnalysis {
  root: string;
  sourceRel: string;
  exportName: string;
  target: ExportInfo;
  files: ProjectFile[]; // source closure + baseline tests
  baselineTests: string[]; // rel paths
  externalImports: string[]; // node: built-ins and installed packages imported by `files`; never read or sent
  types: string[]; // tsconfig "types" for execution copies: ["node"] when the project has @types/node installed
  packageHashes: Record<string, string>; // package.json, lockfile
  toolVersions: Record<string, string>;
  exclusions: string[];
}

const toPosix = (p: string) => p.split(path.sep).join('/');

export function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind) =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);

function checkFunctionShape(fn: ts.SignatureDeclarationBase & { body?: ts.Node; asteriskToken?: ts.Node }): string | undefined {
  if (fn.asteriskToken) return 'generators are not supported';
  if (fn.typeParameters?.length) return 'generic functions are not supported';
  if (!fn.body) return 'function has no body';
  return undefined;
}

/** Lists named exported functions and arrow functions, marking which are eligible. */
export function findExports(sf: ts.SourceFile): ExportInfo[] {
  const out: ExportInfo[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  for (const stmt of sf.statements) {
    if (!hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) continue;
    const isDefault = hasModifier(stmt, ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      const reason = isDefault ? 'default exports are not supported' : checkFunctionShape(stmt);
      out.push({ name: stmt.name.text, line: line(stmt), eligible: !reason, isAsync: hasModifier(stmt, ts.SyntaxKind.AsyncKeyword), reason, bodyStart: stmt.body.getStart(sf), bodyEnd: stmt.body.end, node: stmt });
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const init = decl.initializer;
        if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) continue;
        const constDecl = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
        const reason = !constDecl ? 'only const arrow functions are supported' : checkFunctionShape(init);
        out.push({ name: decl.name.text, line: line(stmt), eligible: !reason, isAsync: hasModifier(init, ts.SyntaxKind.AsyncKeyword), reason, bodyStart: init.body.getStart(sf), bodyEnd: init.body.end, node: init });
      }
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      out.push({ name: stmt.name.text, line: line(stmt), eligible: false, isAsync: false, reason: 'classes are not supported', bodyStart: 0, bodyEnd: 0, node: stmt });
    }
  }
  return out;
}

interface ImportRef {
  specifier: string;
  typeOnly: boolean;
  names: string[];
}

/** Collects static imports/re-exports and rejects require() and dynamic import(). */
function scanModule(sf: ts.SourceFile): { imports: ImportRef[]; problems: string[] } {
  const imports: ImportRef[] = [];
  const problems: string[] = [];
  for (const stmt of sf.statements) {
    if ((ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      let typeOnly = false;
      const names: string[] = [];
      if (ts.isImportDeclaration(stmt)) {
        const clause = stmt.importClause;
        typeOnly = !!clause?.isTypeOnly;
        if (clause?.name) names.push('default');
        const nb = clause?.namedBindings;
        if (nb && ts.isNamedImports(nb)) names.push(...nb.elements.map((e) => (e.propertyName ?? e.name).text));
        if (nb && ts.isNamespaceImport(nb)) names.push('*');
      } else {
        typeOnly = stmt.isTypeOnly;
        // Re-exported names count as imported: `export * from 'vitest'` would pass on every Vitest API.
        const clause = stmt.exportClause;
        if (!clause || ts.isNamespaceExport(clause)) names.push('*');
        else names.push(...clause.elements.map((e) => (e.propertyName ?? e.name).text));
      }
      imports.push({ specifier: stmt.moduleSpecifier.text, typeOnly, names });
    } else if (ts.isImportEqualsDeclaration(stmt)) {
      problems.push('`import = require()` is not supported');
    }
  }
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword) problems.push('dynamic import() is not supported');
      if (ts.isIdentifier(n.expression) && n.expression.text === 'require') problems.push('require() is not supported');
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { imports, problems };
}

function readPackage(root: string, name: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

const major = (v: string) => Number(v.split('.')[0]);

/** Lockfiles accepted as a sign that dependencies are installed. They are only hashed. */
export const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

/** Checks the prepared-project contract. Throws `setup`/`unsupported` errors with instructions. */
export function checkProject(root: string): { toolVersions: Record<string, string>; packageHashes: Record<string, string> } {
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) throw new TestForgeError('unsupported', 'The workspace folder has no package.json. TestForge supports one package per workspace folder.');
  const pkgText = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgText) as { type?: string; workspaces?: unknown };
  if (pkg.type !== undefined && pkg.type !== 'module' && pkg.type !== 'commonjs') throw new TestForgeError('unsupported', `package.json "type" must be "module" or "commonjs", not ${JSON.stringify(pkg.type)}.`);
  if (pkg.workspaces || fs.existsSync(path.join(root, 'pnpm-workspace.yaml'))) throw new TestForgeError('unsupported', 'Workspaces/monorepos (package.json "workspaces" or pnpm-workspace.yaml) are not supported.');
  const locks = LOCKFILES.filter((l) => fs.existsSync(path.join(root, l)));
  if (!locks.length) throw new TestForgeError('unsupported', `No lockfile was found (${LOCKFILES.join(', ')}). TestForge supports projects whose dependencies are already installed.`);
  const vitest = readPackage(root, 'vitest');
  const typescript = readPackage(root, 'typescript');
  const need = `Install them yourself, e.g. \`npm i -D vitest@${toolchain.target.vitest.tested} typescript@${toolchain.target.typescript.tested}\`. TestForge never installs packages.`;
  if (!vitest || !typescript) throw new TestForgeError('setup', `Local vitest and typescript must be installed in node_modules. ${need}`);
  if (!toolchain.target.vitest.majors.includes(major(vitest))) throw new TestForgeError('setup', `vitest ${vitest} is not supported (supported majors: ${toolchain.target.vitest.majors.join(', ')}). ${need}`);
  if (!toolchain.target.typescript.majors.includes(major(typescript))) throw new TestForgeError('setup', `typescript ${typescript} is not supported (supported majors: ${toolchain.target.typescript.majors.join(', ')}). ${need}`);
  const packageHashes: Record<string, string> = { 'package.json': sha256(pkgText) };
  for (const l of locks) packageHashes[l] = sha256(fs.readFileSync(path.join(root, l)));
  return { toolVersions: { vitest, typescript }, packageHashes };
}

function realInside(root: string, file: string): boolean {
  const realRoot = fs.realpathSync(root);
  const real = fs.realpathSync(file);
  const rel = path.relative(realRoot, real);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolveRelative(fromAbs: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(fromAbs), specifier);
  if (specifier.endsWith('.js')) return base.slice(0, -3) + '.ts';
  if (specifier.endsWith('.ts')) return base;
  return undefined;
}

const isRelative = (specifier: string) => specifier.startsWith('./') || specifier.startsWith('../');

/** npm package name of a bare specifier (`pkg`, `pkg/sub`, `@scope/pkg/sub`), or undefined when it is not one. */
function packageName(specifier: string): string | undefined {
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return /^(@[a-z0-9~-][\w.~-]*\/)?[a-z0-9~-][\w.~-]*$/i.test(name) ? name : undefined;
}

/**
 * Non-relative imports are allowed for `node:` built-ins and for packages installed in the
 * project's node_modules (only the existence of their package.json is checked; their code is
 * never read). Returns why anything else is not supported.
 */
function externalProblem(root: string, specifier: string): string | undefined {
  if (specifier.startsWith('node:')) return /^node:\w+(\/\w+)*$/.test(specifier) ? undefined : 'It is not a Node.js built-in module name.';
  const name = packageName(specifier);
  if (name && fs.existsSync(path.join(root, 'node_modules', name, 'package.json'))) return undefined;
  if (isBuiltin(specifier)) return `Import Node.js built-ins with the "node:" prefix ("node:${specifier}").`;
  return 'Only relative .ts imports, node: built-ins and packages installed in node_modules are supported (no path aliases).';
}

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\b(api[_-]?key|secret|password|passwd|token)\b\s*[:=]\s*['"`][^'"`\s]{8,}['"`]/i,
];

export function findSecret(text: string): number | undefined {
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => SECRET_PATTERNS.some((p) => p.test(l)));
  return idx >= 0 ? idx + 1 : undefined;
}

// Hooks, vi, .skip/.todo, .each/.for and computed titles are allowed: Vitest's JSON report names
// every test, skipped tests never detect a mutation, and the two-run check catches nondeterminism.
// Still rejected: focus, modifiers that change how or whether tests run, fixtures, Jest aliases.
const FORBIDDEN_TEST_MEMBERS = new Set(['only', 'concurrent', 'skipIf', 'runIf', 'fails', 'extend']);
const FORBIDDEN_TEST_CALLS = new Set(['fit', 'xit', 'xtest', 'fdescribe', 'xdescribe']);
const ALLOWED_VITEST_NAMES = new Set(['test', 'it', 'expect', 'describe', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'vi']);

/** Enforces the baseline test restrictions from the support matrix. */
export function checkTestFile(sf: ts.SourceFile): string[] {
  const problems: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAccessExpression(n)) {
      const name = n.name.text;
      // Chains count too: `test.skip.only` focuses as much as `test.only`.
      let root = n.expression;
      while (ts.isPropertyAccessExpression(root)) root = root.expression;
      if (FORBIDDEN_TEST_MEMBERS.has(name) && ts.isIdentifier(root) && ['test', 'it', 'describe', 'expect'].includes(root.text)) problems.push(`\`${n.getText(sf)}\` is not supported`);
      if (/^toMatch(Inline)?Snapshot$|^toThrowErrorMatching(Inline)?Snapshot$|^toMatchFileSnapshot$/.test(name)) problems.push('snapshots are not supported');
    }
    if (ts.isIdentifier(n) && FORBIDDEN_TEST_CALLS.has(n.text) && ts.isCallExpression(n.parent) && n.parent.expression === n) problems.push(`\`${n.text}\` is not supported`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...new Set(problems)];
}

/** Regular files named `names` in `dir` (and, when `deep`, its subfolders), skipping symlinks, dot folders and node_modules. */
function findFiles(dir: string, names: string[], deep: boolean): string[] {
  if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  const out: string[] = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(dir, d.name);
    if (d.isFile() && names.includes(d.name)) out.push(abs);
    else if (deep && d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules') out.push(...findFiles(abs, names, true));
  }
  return out;
}

/** True when the file imports `sourceAbs` itself through a relative specifier (with or without an extension). */
function importsModule(fileAbs: string, sourceAbs: string): boolean {
  const { imports } = scanModule(parse(fileAbs, fs.readFileSync(fileAbs, 'utf8')));
  const target = sourceAbs.slice(0, -'.ts'.length);
  return imports.some((i) => isRelative(i.specifier) && path.resolve(path.dirname(fileAbs), i.specifier).replace(/\.[jt]s$/, '') === target);
}

/**
 * Baseline tests: x.test.ts, x.spec.ts and x.testforge.*.test.ts next to the module; plus
 * __tests__/x.test.ts|spec.ts in its folder and x.test.ts|spec.ts anywhere under the top-level
 * test/ or tests/ folder of `root`, but only those that import the module directly, so unrelated
 * files with the same name are ignored.
 */
export function adjacentTestNames(sourceAbs: string, root?: string): string[] {
  const dir = path.dirname(sourceAbs);
  const base = path.basename(sourceAbs, '.ts');
  const names = fs.readdirSync(dir).filter((f) => f === `${base}.test.ts` || f === `${base}.spec.ts` || (f.startsWith(`${base}.testforge.`) && f.endsWith('.test.ts')));
  const out = names.sort().map((f) => path.join(dir, f));
  const testNames = [`${base}.test.ts`, `${base}.spec.ts`];
  const candidates = findFiles(path.join(dir, '__tests__'), testNames, false);
  if (root) for (const t of ['test', 'tests']) candidates.push(...findFiles(path.join(root, t), testNames, true));
  for (const c of candidates) if (!out.includes(c) && importsModule(c, sourceAbs)) out.push(c);
  return out;
}

/**
 * Full preflight analysis of one export. Throws TestForgeError with a precise reason
 * for anything outside the support matrix.
 */
export function analyzeTarget(root: string, sourceAbs: string, exportName: string): TargetAnalysis {
  if (!sourceAbs.endsWith('.ts') || sourceAbs.endsWith('.d.ts') || /\.(test|spec)\.ts$/.test(sourceAbs)) {
    throw new TestForgeError('unsupported', 'Only TypeScript source files (.ts, not tests or declarations) are supported.');
  }
  if (!realInside(root, sourceAbs)) throw new TestForgeError('unsupported', 'The file is outside the workspace folder (or reached through a symlink that leaves it).');
  const { toolVersions, packageHashes } = checkProject(root);
  const exclusions: string[] = [];
  const externalImports: string[] = [];
  const files = new Map<string, ProjectFile>();

  const addFile = (abs: string, role: ProjectFile['role']) => {
    const rel = toPosix(path.relative(root, abs));
    if (files.has(rel)) return undefined;
    if (!fs.existsSync(abs)) throw new TestForgeError('unsupported', `Import target ${rel} does not exist (only .ts files reached through ".js" or ".ts" specifiers are supported).`);
    if (!realInside(root, abs)) throw new TestForgeError('unsupported', `${rel} resolves outside the workspace through a symlink.`);
    const buf = fs.readFileSync(abs);
    if (buf.length > LIMITS.maxFileBytes) throw new TestForgeError('unsupported', `${rel} is larger than ${LIMITS.maxFileBytes / 1024} KiB.`);
    const text = buf.toString('utf8');
    const secretLine = findSecret(text);
    if (secretLine) throw new TestForgeError('blocked', `${rel}:${secretLine} looks like it contains a secret. TestForge stops rather than send it to a model. Move the value out of the file or rename it if it is a false positive.`);
    const f: ProjectFile = { rel, text, hash: sha256(buf), role };
    files.set(rel, f);
    return f;
  };

  const walk = (abs: string, role: ProjectFile['role']) => {
    const f = addFile(abs, role);
    if (!f) return;
    const sf = parse(abs, f.text);
    const { imports, problems } = scanModule(sf);
    if (problems.length) throw new TestForgeError('unsupported', `${f.rel}: ${problems.join('; ')}.`);
    // Test helpers may import vitest now that installed packages are allowed: they follow the same rules as tests.
    if (role === 'test' || imports.some((i) => i.specifier === 'vitest')) {
      const tp = checkTestFile(sf);
      if (tp.length) throw new TestForgeError('unsupported', `${role === 'test' ? 'Existing test' : 'Test helper'} ${f.rel} uses unsupported features: ${tp.join('; ')}. TestForge will not silently ignore it.`);
    }
    for (const imp of imports) {
      if (imp.specifier === 'vitest') {
        const bad = imp.names.filter((n) => !ALLOWED_VITEST_NAMES.has(n));
        if (bad.length) throw new TestForgeError('unsupported', `${f.rel} imports ${bad.join(', ')} from vitest; only ${[...ALLOWED_VITEST_NAMES].join(', ')} are supported.`);
        continue;
      }
      if (!isRelative(imp.specifier)) {
        const problem = externalProblem(root, imp.specifier);
        if (problem) throw new TestForgeError('unsupported', `${f.rel} imports "${imp.specifier}". ${problem}`);
        if (!externalImports.includes(imp.specifier)) externalImports.push(imp.specifier);
        continue;
      }
      const target = resolveRelative(abs, imp.specifier);
      if (!target) throw new TestForgeError('unsupported', `${f.rel} imports "${imp.specifier}" without a .js or .ts extension.`);
      walk(target, 'source');
    }
  };

  const sourceText = fs.readFileSync(sourceAbs, 'utf8');
  const exports = findExports(parse(sourceAbs, sourceText));
  const target = exports.find((e) => e.name === exportName);
  if (!target) throw new TestForgeError('unsupported', `No named exported function "${exportName}" was found.`);
  if (!target.eligible) throw new TestForgeError('unsupported', `${exportName}: ${target.reason}.`);

  walk(sourceAbs, 'source');
  const baselineTests: string[] = [];
  for (const t of adjacentTestNames(sourceAbs, root)) {
    walk(t, 'test');
    baselineTests.push(toPosix(path.relative(root, t)));
  }
  const sources = [...files.values()].filter((f) => f.role === 'source');
  if (sources.length > LIMITS.maxSourceFiles) throw new TestForgeError('unsupported', `The import closure has ${sources.length} files (limit ${LIMITS.maxSourceFiles}).`);
  if (baselineTests.length > LIMITS.maxTestFiles) throw new TestForgeError('unsupported', `There are ${baselineTests.length} baseline test files (limit ${LIMITS.maxTestFiles}).`);
  const total = [...files.values()].reduce((n, f) => n + Buffer.byteLength(f.text), 0);
  if (total > LIMITS.maxContextBytes) throw new TestForgeError('unsupported', `Relevant files total ${Math.round(total / 1024)} KiB (limit ${LIMITS.maxContextBytes / 1024} KiB).`);
  // Execution copies type-check Node built-in imports and Node globals (Buffer, process) against the project's @types/node.
  const builtin = externalImports.find((s) => s.startsWith('node:'));
  const nodeTypes = fs.existsSync(path.join(root, 'node_modules', '@types', 'node', 'package.json'));
  if (builtin && !nodeTypes) {
    throw new TestForgeError('setup', `The code imports "${builtin}", which needs @types/node to type-check. Install it yourself, e.g. \`npm i -D @types/node\`. TestForge never installs packages.`);
  }
  for (const s of externalImports) exclusions.push(`${s.startsWith('node:') ? 'Node built-in' : 'package'} import ${s} (not sent)`);

  const sourceRel = toPosix(path.relative(root, sourceAbs));
  const refreshed = findExports(parse(sourceAbs, files.get(sourceRel)!.text)).find((e) => e.name === exportName)!;
  return { root, sourceRel, exportName, target: refreshed, files: [...files.values()], baselineTests, externalImports, types: nodeTypes ? ['node'] : [], packageHashes, toolVersions, exclusions };
}
