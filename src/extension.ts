// VS Code adapter: commands, CodeLens, consent, progress, results view, preview and apply.
// Product logic lives in vscode-free modules; this file never invents results.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { analyzeTarget, findExports, parse } from './analysis/analyze';
import { runPipeline } from './core/pipeline';
import { CONSENT_POLICY_VERSION, RunReport, TestForgeError } from './core/types';
import { KeyedMutex } from './core/util';
import { killAll } from './execution/runner';
import { cleanupStale } from './execution/workspace';
import { buildPrompt, evidenceFiles, existingTitles } from './generation/prompt';
import { applyMutation } from './mutation/mutate';
import { FakeProvider } from './providers/fake';
import type { ModelProvider } from './providers/provider';
import { modelLabel, VsCodeLmProvider } from './providers/vscodeLm';
import { applyGenerated, pruneHistory, staleReasons, StoredRun } from './storage/apply';
import { ResultsProvider } from './ui/results';

const HISTORY_KEY = 'testforge.history';
const MODEL_KEY = 'testforge.modelId';
const PREVIEW_SCHEME = 'testforge-preview';

let ctx: vscode.ExtensionContext;
let output: vscode.OutputChannel;
let results: ResultsProvider;
const mutex = new KeyedMutex();
const active = new Map<string, AbortController>();
const previews = new Map<string, string>();
let previewEmitter: vscode.EventEmitter<vscode.Uri>;

// ---------- history ----------

function history(): StoredRun[] {
  return ctx.workspaceState.get<StoredRun[]>(HISTORY_KEY, []);
}

async function saveRun(run: StoredRun): Promise<void> {
  const rest = history().filter((r) => r.report.runId !== run.report.runId);
  await ctx.workspaceState.update(HISTORY_KEY, pruneHistory([run, ...rest]));
}

function dirtyPaths(): string[] {
  return vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === 'file').map((d) => d.uri.fsPath);
}

function showRun(run: StoredRun | undefined): void {
  results.show(run, run ? staleReasons(run, dirtyPaths()) : []);
}

// ---------- guards ----------

function requireTrust(): boolean {
  if (vscode.workspace.isTrusted) return true;
  void vscode.window.showWarningMessage('TestForge needs a trusted workspace to analyze or run code. In Restricted Mode you can only open saved reports.');
  return false;
}

async function ensureConsent(provider: ModelProvider, files: string[], prompt: string): Promise<boolean> {
  const key = `testforge.consent.v${CONSENT_POLICY_VERSION}.${provider.isFake ? 'execution-only' : provider.label}`;
  if (ctx.workspaceState.get<boolean>(key)) return true;
  // Extension-host tests only (set in .vscode-test.mjs); never set for users.
  if (ctx.extensionMode === vscode.ExtensionMode.Test && process.env.TESTFORGE_TEST_CONSENT === '1') return true;
  const send = provider.isFake
    ? 'DEMO mode: nothing is sent to any model.'
    : `TestForge will send ${files.length} file(s) to ${provider.label}:\n${files.join('\n')}\n\nOnly the selected module, its relative imports and its adjacent tests are sent.`;
  const detail = `${send}\n\nIt will also run your project's TypeScript compiler and Vitest on temporary copies of these files. This runs your code as you. Temporary copies are NOT a security sandbox.`;
  for (;;) {
    const pick = await vscode.window.showWarningMessage('Allow TestForge for this workspace?', { modal: true, detail }, 'Allow', 'Show Outgoing Context');
    if (pick === 'Show Outgoing Context') {
      await openPreview(`/context/${Date.now()}.txt`, provider.isFake ? '(DEMO mode: nothing is sent.)' : prompt);
      continue;
    }
    if (pick !== 'Allow') return false;
    await ctx.workspaceState.update(key, true);
    return true;
  }
}

// ---------- model ----------

async function pickModel(): Promise<vscode.LanguageModelChat | undefined> {
  const models = await vscode.lm.selectChatModels();
  if (!models.length) {
    void vscode.window.showErrorMessage('No language models are available. Install and sign in to a model provider such as GitHub Copilot, or try "TestForge: Run Demo".');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    models.map((m) => ({ label: m.name, description: `${m.vendor}/${m.family}`, detail: `max input ${m.maxInputTokens} tokens`, model: m })),
    { title: 'TestForge: select a model', placeHolder: 'The model receives the bounded context shown before each first use' },
  );
  if (!pick) return undefined;
  await ctx.globalState.update(MODEL_KEY, pick.model.id);
  return pick.model;
}

async function currentModel(): Promise<vscode.LanguageModelChat | undefined> {
  const id = ctx.globalState.get<string>(MODEL_KEY);
  if (id) {
    const [m] = await vscode.lm.selectChatModels({ id });
    if (m) return m;
  }
  return pickModel();
}

// ---------- target selection ----------

async function resolveTarget(uri?: vscode.Uri, exportName?: string): Promise<{ uri: vscode.Uri; exportName: string } | undefined> {
  const editor = vscode.window.activeTextEditor;
  const doc = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
  if (!doc || doc.uri.scheme !== 'file' || doc.languageId !== 'typescript') {
    void vscode.window.showErrorMessage('Open a saved TypeScript (.ts) file first. Other languages are not supported yet.');
    return undefined;
  }
  if (exportName) return { uri: doc.uri, exportName };
  const exports = findExports(parse(doc.fileName, doc.getText()));
  const eligible = exports.filter((e) => e.eligible);
  if (!eligible.length) {
    const why = exports.map((e) => `${e.name}: ${e.reason}`).join('; ');
    void vscode.window.showErrorMessage(`No eligible exported function in this file.${why ? ` ${why}` : ' Only named exported sync functions and const arrow functions are supported.'}`);
    return undefined;
  }
  if (editor && editor.document === doc) {
    const offset = doc.offsetAt(editor.selection.active);
    const hit = eligible.find((e) => offset >= e.node.getFullStart() && offset <= e.node.getEnd());
    if (hit) return { uri: doc.uri, exportName: hit.name };
  }
  if (eligible.length === 1) return { uri: doc.uri, exportName: eligible[0].name };
  const pick = await vscode.window.showQuickPick(eligible.map((e) => ({ label: e.name, description: `line ${e.line}` })), { title: 'TestForge: choose a function' });
  return pick && { uri: doc.uri, exportName: pick.label };
}

// ---------- main command ----------

async function generate(demo: boolean, uri?: vscode.Uri, exportName?: string): Promise<RunReport | undefined> {
  if (!requireTrust()) return undefined;
  const target = await resolveTarget(uri, exportName);
  if (!target) return undefined;
  const folder = vscode.workspace.getWorkspaceFolder(target.uri);
  if (!folder || folder.uri.scheme !== 'file') {
    void vscode.window.showErrorMessage('The file must be inside a local workspace folder.');
    return undefined;
  }
  const root = folder.uri.fsPath;
  const release = mutex.tryAcquire(root);
  if (!release) {
    const pick = await vscode.window.showWarningMessage('A TestForge run is already active in this workspace.', 'Cancel Active Run');
    if (pick) active.get(root)?.abort();
    return undefined;
  }
  try {
    // Preflight before any model request or process: support matrix and dirty files.
    let analysis;
    try {
      analysis = analyzeTarget(root, target.uri.fsPath, target.exportName);
    } catch (e) {
      if (e instanceof TestForgeError) {
        void vscode.window.showErrorMessage(`TestForge cannot run: ${e.message}`);
        return undefined;
      }
      throw e;
    }
    const relevant = new Set(analysis.files.map((f) => path.join(root, f.rel)));
    const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && relevant.has(d.uri.fsPath));
    if (dirty.length) {
      const pick = await vscode.window.showWarningMessage(`${dirty.length} relevant file(s) have unsaved changes.`, { modal: true, detail: dirty.map((d) => vscode.workspace.asRelativePath(d.uri)).join('\n') }, 'Save and Continue');
      if (pick !== 'Save and Continue') return undefined;
      for (const d of dirty) if (!(await d.save())) return undefined;
      analysis = analyzeTarget(root, target.uri.fsPath, target.exportName);
    }

    let provider: ModelProvider;
    if (demo) provider = new FakeProvider();
    else {
      const model = await currentModel();
      if (!model) return undefined;
      provider = new VsCodeLmProvider(model);
    }
    const prompt = buildPrompt(analysis, evidenceFiles(analysis), { maxCases: 8, existingTitles: existingTitles(analysis) });
    if (!(await ensureConsent(provider, analysis.files.map((f) => f.rel), prompt))) return undefined;

    const cfg = vscode.workspace.getConfiguration('testforge');
    const abort = new AbortController();
    active.set(root, abort);
    output.appendLine(`[${new Date().toISOString()}] ${demo ? 'DEMO ' : ''}run for ${target.exportName} in ${vscode.workspace.asRelativePath(target.uri)} using ${provider.label}`);
    const report = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `TestForge${demo ? ' (DEMO)' : ''}: ${target.exportName}`, cancellable: true },
      (progress, token) => {
        token.onCancellationRequested(() => abort.abort());
        return runPipeline({
          root,
          sourceAbs: target.uri.fsPath,
          exportName: target.exportName,
          provider,
          nodePath: cfg.get<string>('nodePath') || undefined,
          mutationSample: cfg.get<number>('mutationSample'),
          globalDeadlineMs: (cfg.get<number>('globalDeadlineSeconds') ?? 180) * 1000,
          signal: abort.signal,
          onStage: (stage, message) => {
            progress.report({ message });
            output.appendLine(`  ${stage}: ${message}`);
          },
        });
      },
    );
    const run: StoredRun = { report, root, savedAt: Date.now() };
    await saveRun(run);
    showRun(run);
    output.appendLine(`  result: ${report.status}${report.failure ? ` (${report.failure.kind}: ${report.failure.message})` : ''}`);
    void vscode.commands.executeCommand('testforge.results.focus');
    const summary = report.failure ? `${report.status.toUpperCase()}: ${report.failure.message}` : `${report.status.toUpperCase()}. See the TestForge Results view.`;
    if (report.status === 'completed') void vscode.window.showInformationMessage(`TestForge ${summary}`, 'Preview Tests').then((p) => p && previewTests());
    else void vscode.window.showWarningMessage(`TestForge ${summary}`);
    return report;
  } finally {
    active.delete(root);
    release();
  }
}

// ---------- preview ----------

async function openPreview(p: string, text: string): Promise<vscode.Uri> {
  const uri = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: p });
  previews.set(uri.toString(), text);
  previewEmitter.fire(uri);
  await vscode.window.showTextDocument(uri, { preview: true });
  return uri;
}

function previewUri(p: string, text: string): vscode.Uri {
  const uri = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: p });
  previews.set(uri.toString(), text);
  previewEmitter.fire(uri);
  return uri;
}

async function previewTests(): Promise<void> {
  const run = results.current();
  if (!run?.report.generatedTest || !run.report.generatedTestPath) {
    void vscode.window.showInformationMessage('No generated tests to preview.');
    return;
  }
  const stale = staleReasons(run, dirtyPaths());
  const left = previewUri(`/${run.report.runId}/empty`, '');
  const right = previewUri(`/${run.report.runId}/${run.report.generatedTestPath}`, run.report.generatedTest);
  await vscode.commands.executeCommand('vscode.diff', left, right, `New file: ${run.report.generatedTestPath}${stale.length ? ' (STALE)' : ''}${run.report.demo ? ' (DEMO)' : ''}`);
}

async function showMutation(id: string): Promise<void> {
  const run = results.current();
  const m = run?.report.mutations.find((x) => x.id === id);
  if (!run || !m) return;
  const abs = path.join(run.root, m.file);
  let text: string;
  try {
    text = fs.readFileSync(abs, 'utf8');
    applyMutation(text, m);
  } catch {
    void vscode.window.showWarningMessage('The source changed since this run, so the mutation can no longer be shown. Run Generate & Verify again.');
    return;
  }
  const left = previewUri(`/${run.report.runId}/${m.id}/original/${m.file}`, text);
  const right = previewUri(`/${run.report.runId}/${m.id}/mutated/${m.file}`, applyMutation(text, m));
  await vscode.commands.executeCommand('vscode.diff', left, right, `Mutation line ${m.line}: ${m.original} → ${m.replacement}`, { selection: new vscode.Range(m.line - 1, 0, m.line - 1, 0) });
}

// ---------- apply / discard / history ----------

async function apply(allowFailing: boolean): Promise<void> {
  if (!requireTrust()) return;
  const run = results.current();
  if (!run) {
    void vscode.window.showInformationMessage('No TestForge run is selected.');
    return;
  }
  const stale = staleReasons(run, dirtyPaths());
  if (stale.length) {
    showRun(run);
    void vscode.window.showWarningMessage(`Apply is disabled because the results are stale (${stale.join('; ')}). Run Generate & Verify again.`);
    return;
  }
  if (allowFailing) {
    const failing = run.report.cases.filter((c) => c.status === 'accepted' && c.originalOutcome !== 'passed');
    const ok = await vscode.window.showWarningMessage(`Apply ${failing.length} FAILING case(s)?`, { modal: true, detail: failing.map((c) => `${c.title}: ${c.originalOutcome}`).join('\n') + '\n\nThese tests fail against the current code. They may reveal a bug or a wrong expectation.' }, 'Apply Failing Candidate');
    if (!ok) return;
  }
  try {
    const r = applyGenerated(run, { allowFailing });
    run.appliedHash = r.hash;
    await saveRun(run);
    showRun(run);
    await vscode.window.showTextDocument(vscode.Uri.file(r.abs));
    if (r.kind === 'already-applied') void vscode.window.showInformationMessage('This run was already applied; opened the existing file.');
  } catch (e) {
    void vscode.window.showErrorMessage(`TestForge did not apply the tests: ${(e as Error).message}`);
  }
}

async function discard(): Promise<void> {
  const run = results.current();
  if (!run) return;
  await ctx.workspaceState.update(HISTORY_KEY, history().filter((r) => r.report.runId !== run.report.runId));
  showRun(undefined);
}

async function clearHistory(): Promise<void> {
  const ok = await vscode.window.showWarningMessage('Delete all saved TestForge reports and pending generated tests for this workspace?', { modal: true }, 'Clear History');
  if (!ok) return;
  await ctx.workspaceState.update(HISTORY_KEY, []);
  showRun(undefined);
}

async function openReport(): Promise<void> {
  const runs = pruneHistory(history());
  if (!runs.length) {
    void vscode.window.showInformationMessage('No saved TestForge reports.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    runs.map((r) => ({ label: `${r.report.exportName} · ${r.report.status}`, description: `${r.report.sourceFile} · ${new Date(r.savedAt).toLocaleString()}${r.report.demo ? ' · DEMO' : ''}`, run: r })),
    { title: 'TestForge: open a report' },
  );
  if (pick) showRun(pick.run);
}

// ---------- CodeLens ----------

class LensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (doc.uri.scheme !== 'file' || /\.(test|spec|d)\.ts$/.test(doc.fileName)) return [];
    return findExports(parse(doc.fileName, doc.getText()))
      .filter((e) => e.eligible)
      .map((e) => new vscode.CodeLens(new vscode.Range(e.line - 1, 0, e.line - 1, 0), { title: 'TestForge: Generate & Verify Tests', command: 'testforge.generateAndVerify', arguments: [doc.uri, e.name] }));
  }
}

// ---------- activation ----------

export function activate(context: vscode.ExtensionContext): { lastReport(): RunReport | undefined } {
  ctx = context;
  output = vscode.window.createOutputChannel('TestForge');
  results = new ResultsProvider();
  previewEmitter = new vscode.EventEmitter<vscode.Uri>();
  const latest = pruneHistory(history())[0];
  if (latest) results.show(latest, []);

  try {
    const removed = cleanupStale();
    if (removed) output.appendLine(`Removed ${removed} stale TestForge run director${removed === 1 ? 'y' : 'ies'}.`);
  } catch {
    // best effort
  }

  const cmd = (id: string, fn: (...args: never[]) => unknown) => vscode.commands.registerCommand(id, fn);
  context.subscriptions.push(
    output,
    previewEmitter,
    vscode.window.registerTreeDataProvider('testforge.results', results),
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, { onDidChange: previewEmitter.event, provideTextDocumentContent: (u) => previews.get(u.toString()) ?? '' }),
    vscode.languages.registerCodeLensProvider({ language: 'typescript', scheme: 'file' }, new LensProvider()),
    cmd('testforge.generateAndVerify', (uri?: vscode.Uri, name?: string) => generate(false, uri, name)),
    cmd('testforge.runDemo', (uri?: vscode.Uri, name?: string) => generate(true, uri, name)),
    cmd('testforge.selectModel', async () => {
      const m = await pickModel();
      if (m) void vscode.window.showInformationMessage(`TestForge will use ${modelLabel(m)}.`);
    }),
    cmd('testforge.cancelRun', () => {
      for (const a of active.values()) a.abort();
    }),
    cmd('testforge.openReport', openReport),
    cmd('testforge.previewTests', previewTests),
    cmd('testforge.applyTests', () => apply(false)),
    cmd('testforge.applyFailingCandidate', () => apply(true)),
    cmd('testforge.discardRun', discard),
    cmd('testforge.clearHistory', clearHistory),
    cmd('testforge.showMutation', (id: string) => showMutation(id)),
    vscode.workspace.onDidSaveTextDocument(() => results.current() && showRun(results.current())),
  );
  return { lastReport: () => results.current()?.report };
}

export function deactivate(): void {
  for (const a of active.values()) a.abort();
  killAll();
}
