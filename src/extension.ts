// VS Code adapter: commands, CodeLens, chat tools, consent, progress, results view, preview and apply.
// Product logic lives in vscode-free modules; this file never invents results.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { adjacentTestNames, findExports, parse, TargetAnalysis } from './analysis/analyze';
import { preflight, RunMode, runPipeline } from './core/pipeline';
import { CONSENT_POLICY_VERSION, LIMITS, RunReport, TestForgeError } from './core/types';
import { KeyedMutex } from './core/util';
import { killAll } from './execution/runner';
import { cleanupStale } from './execution/workspace';
import { buildPrompt, evidenceFiles, existingTitles } from './generation/prompt';
import { applyMutation } from './mutation/mutate';
import { FakeProvider } from './providers/fake';
import type { ModelProvider } from './providers/provider';
import { modelLabel, VsCodeLmProvider } from './providers/vscodeLm';
import { proofMarkdown } from './report/markdown';
import { applyGenerated, pruneHistory, staleReasons, StoredRun } from './storage/apply';
import { EditorInsights } from './ui/insights';
import { ResultsProvider } from './ui/results';
import { fmtScore, summarize } from './ui/summary';

const HISTORY_KEY = 'testforge.history';
const MODEL_KEY = 'testforge.modelId';
const PREVIEW_SCHEME = 'testforge-preview';

let ctx: vscode.ExtensionContext;
let output: vscode.OutputChannel;
let results: ResultsProvider;
let insights: EditorInsights;
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
  const stale = run ? staleReasons(run, dirtyPaths()) : [];
  results.show(run, stale);
  insights.show(run, stale);
}

// ---------- guards ----------

/** Output channel line. Extension-host tests also print it, so CI logs say why a run did not start. */
function log(line: string): void {
  output.appendLine(line);
  if (ctx.extensionMode === vscode.ExtensionMode.Test) console.log(`[TestForge] ${line}`);
}

/** Shows why a run did not start, and logs it. */
function notStarted(message: string, level: 'error' | 'warning' = 'error'): undefined {
  log(`Not started: ${message}`);
  void (level === 'error' ? vscode.window.showErrorMessage(message) : vscode.window.showWarningMessage(message));
  return undefined;
}

function requireTrust(): boolean {
  if (vscode.workspace.isTrusted) return true;
  notStarted('TestForge needs a trusted workspace to analyze or run code. In Restricted Mode you can only open saved reports.', 'warning');
  return false;
}

/** Extension-host tests only (set in .vscode-test.mjs); never set for users. */
const testConsent = () => ctx.extensionMode === vscode.ExtensionMode.Test && process.env.TESTFORGE_TEST_CONSENT === '1';

/** `provider` is undefined for an audit. Audits and demo runs send nothing, so they share one execution-only consent. */
async function ensureConsent(provider: ModelProvider | undefined, files: string[], prompt: string): Promise<boolean> {
  const sends = provider && !provider.isFake ? provider : undefined;
  const key = `testforge.consent.v${CONSENT_POLICY_VERSION}.${sends ? sends.label : 'execution-only'}`;
  if (ctx.workspaceState.get<boolean>(key)) return true;
  if (testConsent()) return true;
  const mode = provider ? 'DEMO' : 'Audit';
  const send = !sends
    ? `${mode} mode: nothing is sent to any model. This permission covers both Run Demo and Audit Existing Tests.\n\nTestForge uses these files:\n${files.join('\n')}`
    : `TestForge will send ${files.length} file(s) to ${sends.label}:\n${files.join('\n')}\n\nOnly the selected module, its relative imports and its existing tests are sent, in up to ${LIMITS.maxModelRequests} requests (a correction retry and an improvement request for missed changes).`;
  const detail = `${send}\n\nIt will also run your project's TypeScript compiler and Vitest on temporary copies of these files. This runs your code as you. Temporary copies are NOT a security sandbox.`;
  for (;;) {
    const pick = await vscode.window.showWarningMessage('Allow TestForge for this workspace?', { modal: true, detail }, 'Allow', 'Show Outgoing Context');
    if (pick === 'Show Outgoing Context') {
      await openPreview(`/context/${Date.now()}.txt`, sends ? prompt : `(${mode} mode: nothing is sent.)`);
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

/** The selected model, else a pick (commands) or, with `pick` false, the first available model without UI (chat tools). */
async function currentModel(pick = true): Promise<vscode.LanguageModelChat | undefined> {
  const id = ctx.globalState.get<string>(MODEL_KEY);
  if (id) {
    const [m] = await vscode.lm.selectChatModels({ id });
    if (m) return m;
  }
  return pick ? pickModel() : (await vscode.lm.selectChatModels())[0];
}

// ---------- target selection ----------

async function resolveTarget(uri?: vscode.Uri, exportName?: string): Promise<{ uri: vscode.Uri; exportName: string } | undefined> {
  const editor = vscode.window.activeTextEditor;
  const doc = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
  if (!doc || doc.uri.scheme !== 'file' || doc.languageId !== 'typescript') return notStarted('Open a saved TypeScript (.ts) file first. Other languages are not supported yet.');
  if (exportName) return { uri: doc.uri, exportName };
  const exports = findExports(parse(doc.fileName, doc.getText()));
  const eligible = exports.filter((e) => e.eligible);
  if (!eligible.length) {
    const why = exports.map((e) => `${e.name}: ${e.reason}`).join('; ');
    return notStarted(`No eligible exported function in this file.${why ? ` ${why}` : ' Only named exported sync functions and const arrow functions are supported.'}`);
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

// ---------- shared run ----------

/** Open documents with unsaved changes among the files a run would copy. */
function unsaved(root: string, analysis: TargetAnalysis): vscode.TextDocument[] {
  const relevant = new Set(analysis.files.map((f) => path.join(root, f.rel)));
  return vscode.workspace.textDocuments.filter((d) => d.isDirty && relevant.has(d.uri.fsPath));
}

/**
 * Runs the pipeline with progress, cancel and logging, then saves the report and shows it in the
 * Results view. Shared by the commands and the chat tools; the caller holds the workspace mutex.
 */
async function execute(root: string, target: { uri: vscode.Uri; exportName: string }, how: RunMode, token?: vscode.CancellationToken): Promise<RunReport> {
  const cfg = vscode.workspace.getConfiguration('testforge');
  const abort = new AbortController();
  active.set(root, abort);
  const onToken = token?.onCancellationRequested(() => abort.abort());
  if (token?.isCancellationRequested) abort.abort();
  const tag = how.mode === 'audit' ? 'AUDIT ' : how.provider.isFake ? 'DEMO ' : '';
  log(`[${new Date().toISOString()}] ${tag}run for ${target.exportName} in ${vscode.workspace.asRelativePath(target.uri)} using ${how.provider?.label ?? 'no model'}${token ? ' (chat tool)' : ''}`);
  try {
    const report = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `TestForge${how.mode === 'audit' ? ' (audit)' : how.provider.isFake ? ' (DEMO)' : ''}: ${target.exportName}`, cancellable: true },
      (progress, progressToken) => {
        progressToken.onCancellationRequested(() => abort.abort());
        return runPipeline({
          root,
          sourceAbs: target.uri.fsPath,
          exportName: target.exportName,
          ...how,
          nodePath: cfg.get<string>('nodePath') || undefined,
          mutationSample: cfg.get<number>('mutationSample'),
          globalDeadlineMs: (cfg.get<number>('globalDeadlineSeconds') ?? 180) * 1000,
          signal: abort.signal,
          onStage: (stage, message) => {
            progress.report({ message });
            log(`  ${stage}: ${message}`);
          },
        });
      },
    );
    const run: StoredRun = { report, root, savedAt: Date.now() };
    await saveRun(run);
    showRun(run);
    log(`  result: ${report.status}${report.failure ? ` (${report.failure.kind}: ${report.failure.message})` : ''}`);
    return report;
  } finally {
    onToken?.dispose();
    active.delete(root);
  }
}

// ---------- main command ----------

/** Command path for Generate & Verify, Run Demo (fake model) and Audit Existing Tests (no model). */
async function generate(mode: 'generate' | 'demo' | 'audit', uri?: vscode.Uri, exportName?: string): Promise<RunReport | undefined> {
  if (!requireTrust()) return undefined;
  const target = await resolveTarget(uri, exportName);
  if (!target) return undefined;
  const folder = vscode.workspace.getWorkspaceFolder(target.uri);
  if (!folder || folder.uri.scheme !== 'file') return notStarted('The file must be inside a local workspace folder.');
  const root = folder.uri.fsPath;
  const release = mutex.tryAcquire(root);
  if (!release) {
    log('Not started: a TestForge run is already active in this workspace.');
    const pick = await vscode.window.showWarningMessage('A TestForge run is already active in this workspace.', 'Cancel Active Run');
    if (pick) active.get(root)?.abort();
    return undefined;
  }
  try {
    // Preflight before any model request or process: support matrix and dirty files.
    const pipelineMode = mode === 'audit' ? 'audit' : 'generate';
    let analysis;
    try {
      analysis = preflight(root, target.uri.fsPath, target.exportName, pipelineMode);
    } catch (e) {
      if (e instanceof TestForgeError) return notStarted(`TestForge cannot run: ${e.message}`);
      throw e;
    }
    const dirty = unsaved(root, analysis);
    if (dirty.length) {
      const pick = await vscode.window.showWarningMessage(`${dirty.length} relevant file(s) have unsaved changes.`, { modal: true, detail: dirty.map((d) => vscode.workspace.asRelativePath(d.uri)).join('\n') }, 'Save and Continue');
      if (pick !== 'Save and Continue') return void log('Not started: unsaved changes were not saved.');
      for (const d of dirty) if (!(await d.save())) return notStarted(`Could not save ${vscode.workspace.asRelativePath(d.uri)}.`);
      analysis = preflight(root, target.uri.fsPath, target.exportName, pipelineMode);
    }

    let how: RunMode = { mode: 'audit' };
    if (mode === 'demo') how = { provider: new FakeProvider() };
    else if (mode === 'generate') {
      const model = await currentModel();
      if (!model) return void log('Not started: no model selected.');
      how = { provider: new VsCodeLmProvider(model) };
    }
    const prompt = buildPrompt(analysis, evidenceFiles(analysis), { maxCases: 8, existingTitles: existingTitles(analysis) });
    if (!(await ensureConsent(how.provider, analysis.files.map((f) => f.rel), prompt))) return void log('Not started: consent was not given.');

    const report = await execute(root, target, how);
    void vscode.commands.executeCommand('testforge.results.focus');
    const scored = report.mode === 'audit' ? ` Existing tests: ${fmtScore(report.scores.baseline)}.` : '';
    const summary = report.failure ? `${report.status.toUpperCase()}: ${report.failure.message}` : `${report.status.toUpperCase()}.${scored} See the TestForge Results view.`;
    if (report.status !== 'completed') void vscode.window.showWarningMessage(`TestForge ${summary}`);
    else if (report.generatedTest) void vscode.window.showInformationMessage(`TestForge ${summary}`, 'Preview Tests').then((p) => p && previewTests());
    else void vscode.window.showInformationMessage(`TestForge ${summary}`);
    return report;
  } finally {
    release();
  }
}

// ---------- chat tools (Copilot agent mode) ----------

interface ToolInput {
  filePath: string;
  functionName?: string;
}

const toolText = (text: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);

/** Resolves `filePath` (absolute, or relative to a workspace folder) and the function. Throws a message for the calling model. */
function toolTarget(input: ToolInput): { root: string; uri: vscode.Uri; exportName: string } {
  if (typeof input?.filePath !== 'string' || !input.filePath) throw new Error('filePath is required: the .ts module that exports the function, for example src/age.ts.');
  const local = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
  const candidates = path.isAbsolute(input.filePath) ? [input.filePath] : local.map((f) => path.join(f.uri.fsPath, input.filePath));
  const abs = candidates.find((p) => fs.statSync(p, { throwIfNoEntry: false })?.isFile());
  const folder = abs ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(abs)) : undefined;
  if (!abs || folder?.uri.scheme !== 'file') throw new Error(`${input.filePath} is not a file in a local workspace folder. Pass an absolute path or a path relative to the workspace folder.`);
  const rel = vscode.workspace.asRelativePath(abs);
  if (!abs.endsWith('.ts') || /\.(test|spec|d)\.ts$/.test(abs)) throw new Error(`${rel} is not a TypeScript source module. Pass the .ts file that exports the function (for example src/age.ts), not a test or declaration file.`);
  let exportName = input.functionName;
  if (!exportName) {
    const exports = findExports(parse(abs, fs.readFileSync(abs, 'utf8')));
    const eligible = exports.filter((e) => e.eligible);
    if (eligible.length > 1) throw new Error(`${rel} exports ${eligible.length} eligible functions (${eligible.map((e) => e.name).join(', ')}). Pass functionName.`);
    if (!eligible.length) throw new Error(`${rel} has no eligible exported function. ${exports.map((e) => `${e.name}: ${e.reason}`).join('; ') || 'Only named exported functions and const arrow functions are supported.'}`);
    exportName = eligible[0].name;
  }
  return { root: folder.uri.fsPath, uri: vscode.Uri.file(abs), exportName };
}

/**
 * Runs that the user confirmed in prepareInvocation (mode, function, model and files). invoke() runs only a
 * confirmed run, so a change between the confirmation and the run (another model, another import) asks again.
 */
const confirmed = new Set<string>();
const consentKey = (mode: string, target: { uri: vscode.Uri; exportName: string }, analysis: TargetAnalysis, model?: vscode.LanguageModelChat) =>
  [mode, target.uri.fsPath, target.exportName, model?.id ?? '', ...analysis.files.map((f) => f.rel)].join('\n');

/** The confirmation is the consent for tool runs: it says which files go to which model, and that project code runs. */
async function prepareTool(mode: 'audit' | 'generate', input: ToolInput): Promise<vscode.PreparedToolInvocation> {
  // Without a resolvable run there is nothing to confirm: invoke() reports the problem without running anything.
  const checking = { invocationMessage: `TestForge: checking ${input?.filePath ?? 'the request'}` };
  let target, analysis, model;
  try {
    if (!vscode.workspace.isTrusted) return checking;
    target = toolTarget(input);
    analysis = preflight(target.root, target.uri.fsPath, target.exportName, mode);
    model = mode === 'generate' ? await currentModel(false) : undefined;
  } catch {
    return checking;
  }
  if (mode === 'generate' && !model) return checking;
  confirmed.add(consentKey(mode, target, analysis, model));
  const files = analysis.files.map((f) => f.rel).join(', ');
  const fn = `${target.exportName} (${vscode.workspace.asRelativePath(target.uri)})`;
  const risk = 'This runs your code as you; temporary copies are NOT a security sandbox.';
  const [invocationMessage, title, message] = model
    ? [
        `Generating and verifying tests for ${fn} with ${modelLabel(model)}`,
        `Generate and verify tests for ${target.exportName}?`,
        `TestForge will send ${files} to ${modelLabel(model)} in up to ${LIMITS.maxModelRequests} requests to propose test cases. It will then run your project's TypeScript compiler and Vitest on temporary copies of these files and the generated tests. ${risk} Nothing is written to your workspace: the tests are applied only when you run "TestForge: Apply Tests".`,
      ]
    : [
        `Auditing the existing tests of ${fn}`,
        `Audit the existing tests of ${target.exportName}?`,
        `TestForge will run your project's TypeScript compiler and Vitest on temporary copies of ${files} to see which small code changes (mutations) of ${target.exportName} the existing tests detect. TestForge uses no AI model; only the result (scores, changed code fragments and test names) comes back to this chat. ${risk} Your files are not changed.`,
      ];
  // Headless extension-host tests: lm.invokeTool without a chat token would show the confirmation as a dialog.
  return testConsent() ? { invocationMessage } : { invocationMessage, confirmationMessages: { title, message } };
}

/** Runs one tool call: the same guards and shared run as the commands, without any dialog. Never applies tests. */
async function invokeTool(mode: 'audit' | 'generate', input: ToolInput, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
  if (!vscode.workspace.isTrusted) throw new Error('TestForge needs a trusted workspace to analyze or run code. Ask the user to trust this workspace.');
  const target = toolTarget(input);
  const release = mutex.tryAcquire(target.root);
  if (!release) throw new Error('A TestForge run is already active in this workspace. Wait until it finishes, then call this tool again.');
  try {
    let analysis: TargetAnalysis;
    try {
      analysis = preflight(target.root, target.uri.fsPath, target.exportName, mode);
    } catch (e) {
      // The analyzer states precisely what is outside the support matrix.
      if (e instanceof TestForgeError) return toolText(`TestForge cannot run on ${target.exportName} in ${vscode.workspace.asRelativePath(target.uri)}: ${e.message}`);
      throw e;
    }
    const dirty = unsaved(target.root, analysis).map((d) => vscode.workspace.asRelativePath(d.uri));
    if (dirty.length) throw new Error(`Unsaved changes in ${dirty.join(', ')}. TestForge runs the saved files: ask the user to save them, then call this tool again.`);
    const model = mode === 'generate' ? await currentModel(false) : undefined;
    if (mode === 'generate' && !model) throw new Error('No language model is available to TestForge. Ask the user to sign in to a model provider such as GitHub Copilot, or to pick a model with "TestForge: Select Model".');
    if (!confirmed.delete(consentKey(mode, target, analysis, model))) throw new Error('The files or the model changed after the confirmation, so TestForge did not run. Call this tool again.');
    const report = await execute(target.root, target, model ? { provider: new VsCodeLmProvider(model) } : { mode: 'audit' }, token);
    return toolText(summarize(report));
  } finally {
    release();
  }
}

const chatTool = (mode: 'audit' | 'generate'): vscode.LanguageModelTool<ToolInput> => ({
  prepareInvocation: (options) => prepareTool(mode, options.input),
  invoke: (options, token) => invokeTool(mode, options.input, token),
});

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
  await vscode.commands.executeCommand('vscode.diff', left, right, `Mutation line ${m.line}: ${m.original} → ${m.replacement || "(removed)"}`, { selection: new vscode.Range(m.line - 1, 0, m.line - 1, 0) });
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

/** Copies the selected run as Markdown for a pull request; returns the text (used by tests). */
async function copyProof(): Promise<string | undefined> {
  const run = results.current();
  if (!run) {
    void vscode.window.showInformationMessage('No TestForge run is selected.');
    return undefined;
  }
  const md = proofMarkdown(run.report, staleReasons(run, dirtyPaths()));
  await vscode.env.clipboard.writeText(md);
  void vscode.window.showInformationMessage('Copied the TestForge proof as Markdown. Paste it into a pull request or review.');
  return md;
}

async function openReport(): Promise<void> {
  const runs = pruneHistory(history());
  if (!runs.length) {
    void vscode.window.showInformationMessage('No saved TestForge reports.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    runs.map((r) => ({ label: `${r.report.exportName} · ${r.report.status}`, description: `${r.report.sourceFile} · ${new Date(r.savedAt).toLocaleString()}${r.report.demo ? ' · DEMO' : ''}${r.report.mode === 'audit' ? ' · AUDIT' : ''}`, run: r })),
    { title: 'TestForge: open a report' },
  );
  if (pick) showRun(pick.run);
}

// ---------- CodeLens ----------

class LensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (doc.uri.scheme !== 'file' || /\.(test|spec|d)\.ts$/.test(doc.fileName)) return [];
    let audit = false; // only modules with existing tests can be audited
    try {
      audit = adjacentTestNames(doc.fileName, vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath).length > 0;
    } catch {
      // folder not readable: no audit lens
    }
    return findExports(parse(doc.fileName, doc.getText()))
      .filter((e) => e.eligible)
      .flatMap((e) => {
        const range = new vscode.Range(e.line - 1, 0, e.line - 1, 0);
        const lenses = [new vscode.CodeLens(range, { title: 'TestForge: Generate & Verify Tests', command: 'testforge.generateAndVerify', arguments: [doc.uri, e.name] })];
        if (audit) lenses.push(new vscode.CodeLens(range, { title: 'TestForge: Audit Tests', command: 'testforge.auditTests', arguments: [doc.uri, e.name] }));
        return lenses;
      });
  }
}

// ---------- activation ----------

export function activate(context: vscode.ExtensionContext): { lastReport(): RunReport | undefined } {
  ctx = context;
  output = vscode.window.createOutputChannel('TestForge');
  results = new ResultsProvider();
  insights = new EditorInsights(context.extensionUri, () => results.current() && showRun(results.current()));
  previewEmitter = new vscode.EventEmitter<vscode.Uri>();
  const latest = pruneHistory(history())[0];
  if (latest) showRun(latest);

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
    insights,
    vscode.window.registerTreeDataProvider('testforge.results', results),
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, { onDidChange: previewEmitter.event, provideTextDocumentContent: (u) => previews.get(u.toString()) ?? '' }),
    vscode.languages.registerCodeLensProvider({ language: 'typescript', scheme: 'file' }, new LensProvider()),
    vscode.lm.registerTool('testforge_auditTests', chatTool('audit')),
    vscode.lm.registerTool('testforge_generateAndVerify', chatTool('generate')),
    cmd('testforge.generateAndVerify', (uri?: vscode.Uri, name?: string) => generate('generate', uri, name)),
    cmd('testforge.runDemo', (uri?: vscode.Uri, name?: string) => generate('demo', uri, name)),
    cmd('testforge.auditTests', (uri?: vscode.Uri, name?: string) => generate('audit', uri, name)),
    cmd('testforge.selectModel', async () => {
      const m = await pickModel();
      if (m) void vscode.window.showInformationMessage(`TestForge will use ${modelLabel(m)}.`);
    }),
    cmd('testforge.cancelRun', () => {
      for (const a of active.values()) a.abort();
    }),
    cmd('testforge.openReport', openReport),
    cmd('testforge.copyProof', copyProof),
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
