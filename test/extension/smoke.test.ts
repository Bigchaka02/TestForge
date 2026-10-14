// Extension-host smoke tests. They run inside a real VS Code with the
// workspace folder fixtures/sample (see .vscode-test.mjs).
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'testforge-dev.testforge';

/** Shape the extension's activate() is expected to return (optional). */
interface TestForgeApi {
  lastReport(): unknown;
}

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'expected fixtures/sample to be open as the workspace folder');
  return folder.uri.fsPath;
}

function ageUri(): vscode.Uri {
  return vscode.Uri.file(path.join(workspaceRoot(), 'src', 'age.ts'));
}

function discountUri(): vscode.Uri {
  return vscode.Uri.file(path.join(workspaceRoot(), 'src', 'discount.ts'));
}

/** Possible-bug warnings from TestForge's editor insights. */
function testforgeDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'TestForge');
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function openAge(): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(ageUri());
  return vscode.window.showTextDocument(doc);
}

function getExtension(): vscode.Extension<TestForgeApi | undefined> {
  const ext = vscode.extensions.getExtension<TestForgeApi | undefined>(EXTENSION_ID);
  assert.ok(ext, `extension ${EXTENSION_ID} is not installed in the test host`);
  return ext;
}

describe('TestForge extension (smoke)', () => {
  before(async () => {
    await openAge();
  });

  it('activates when a TypeScript file is opened', async () => {
    const ext = getExtension();
    await waitFor('extension activation', () => (ext.isActive ? true : undefined));
    assert.equal(ext.isActive, true);
  });

  it('registers every contributed command', async () => {
    const ext = getExtension();
    await ext.activate();
    const contributed: string[] = (ext.packageJSON.contributes?.commands ?? []).map((c: { command: string }) => c.command);
    assert.ok(contributed.length > 0, 'package.json contributes no commands');
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = contributed.filter((c) => !registered.has(c));
    assert.deepEqual(missing, [], `commands contributed but not registered: ${missing.join(', ')}`);
  });

  it('shows a CodeLens above isEligible', async () => {
    await getExtension().activate();
    const uri = ageUri();
    const doc = await vscode.workspace.openTextDocument(uri);
    const fnLine = doc.getText().split(/\r?\n/).findIndex((l) => l.includes('function isEligible'));
    assert.ok(fnLine >= 0, 'fixture age.ts no longer declares isEligible');

    const lens = await waitFor('a TestForge CodeLens on isEligible', async () => {
      const lenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri, 100)) ?? [];
      return lenses.find((l) => l.command?.command?.startsWith('testforge.') && Math.abs(l.range.start.line - fnLine) <= 1);
    });
    assert.equal(lens.command?.command, 'testforge.generateAndVerify');
  });

  it('shows an audit CodeLens only for modules with adjacent tests', async () => {
    await getExtension().activate();
    const lenses = async (file: string) => {
      // The CodeLens command needs the document to be open.
      const { uri } = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspaceRoot(), 'src', file)));
      // Wait for the generate lens, so an absent audit lens means the provider ran.
      return waitFor(`TestForge CodeLenses in ${file}`, async () => {
        const all = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri, 100)) ?? [];
        const ours = all.map((l) => l.command?.command).filter((c) => c?.startsWith('testforge.'));
        return ours.includes('testforge.generateAndVerify') ? ours : undefined;
      });
    };
    assert.ok((await lenses('age.ts')).includes('testforge.auditTests'), 'no audit CodeLens in age.ts, which has age.test.ts');
    assert.ok(!(await lenses('clamp.ts')).includes('testforge.auditTests'), 'audit CodeLens in clamp.ts, which has no tests');
  });

  it('notices a test file created outside the editor', async () => {
    await getExtension().activate();
    const { uri } = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspaceRoot(), 'src', 'clamp.ts')));
    const audit = async () => ((await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri, 100)) ?? []).some((l) => l.command?.command === 'testforge.auditTests');
    const test = path.join(workspaceRoot(), 'src', 'clamp.test.ts');
    fs.writeFileSync(test, '// created on disk by the smoke test\n');
    try {
      await waitFor('an audit CodeLens in clamp.ts after clamp.test.ts was created on disk', async () => ((await audit()) ? true : undefined));
    } finally {
      fs.rmSync(test, { force: true });
    }
    await waitFor('the audit CodeLens to go after clamp.test.ts was deleted', async () => ((await audit()) ? undefined : true));
  });

  it('runDemo on isEligible produces a report', async function () {
    const ext = getExtension();
    const api = await ext.activate();
    const editor = await openAge();
    const fnLine = editor.document.getText().split(/\r?\n/).findIndex((l) => l.includes('function isEligible'));
    const col = editor.document.lineAt(fnLine).text.indexOf('isEligible');
    const pos = new vscode.Position(fnLine, col);
    editor.selection = new vscode.Selection(pos, pos);

    // The command targets the export under the cursor.
    await vscode.commands.executeCommand('testforge.runDemo');

    if (!api || typeof api.lastReport !== 'function') {
      console.warn('SKIPPED ASSERTION: activate() does not return { lastReport() }, so the demo report cannot be inspected.');
      this.skip();
      return;
    }
    const report = await waitFor('a RunReport from runDemo', () => api.lastReport() ?? undefined, 180_000);
    assert.equal(typeof report, 'object');
    const r = report as { schemaVersion?: unknown; status?: unknown; failure?: unknown };
    assert.equal(r.schemaVersion, 1);
    assert.equal(typeof r.status, 'string');

    // Editor insights: a score CodeLens above isEligible, and no possible-bug warning for age.ts.
    assert.equal(r.status, 'completed', `the demo run ended ${String(r.status)}: ${JSON.stringify(r.failure)}`);
    const score = await waitFor('the TestForge score CodeLens on isEligible', async () => {
      const lenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', ageUri(), 100)) ?? [];
      return lenses.find((l) => l.command?.command === 'testforge.results.focus');
    });
    assert.equal(score.range.start.line, fnLine);
    assert.match(score.command?.title ?? '', /^TestForge: existing tests catch 1\/3 changes → 3\/3 with generated tests/);
    assert.deepEqual(testforgeDiagnostics(ageUri()), []);
    // Cleanup removes the temporary copies' node_modules links, never the project's packages.
    for (const pkg of ['vitest', 'typescript']) assert.ok(fs.existsSync(path.join(workspaceRoot(), 'node_modules', pkg, 'package.json')), `the run deleted ${pkg} from the project's node_modules`);
  });

  it('runDemo on finalPrice warns about the documented case the code fails', async () => {
    const api = await getExtension().activate();
    const uri = discountUri();
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    // The same arguments the CodeLens above finalPrice passes.
    const returned = await vscode.commands.executeCommand<unknown>('testforge.runDemo', uri, 'finalPrice');
    assert.ok(returned, 'runDemo on finalPrice did not start a run; the [TestForge] log lines above say why');
    const r = api?.lastReport() as { status?: unknown; failure?: unknown } | undefined;
    assert.equal(r?.status, 'partial', `the demo run ended ${String(r?.status)}: ${JSON.stringify(r?.failure)}`);

    const found = await waitFor('a possible-bug diagnostic on discount.ts', () => {
      const ds = testforgeDiagnostics(uri);
      return ds.length ? ds : undefined;
    });
    assert.equal(found.length, 1);
    const [bug] = found;
    assert.equal(bug.severity, vscode.DiagnosticSeverity.Warning);
    assert.match(bug.message, /^Possible bug \(DEMO\): "member order of exactly 100 costs 90" is documented \(src\/discount\.ts:3\) but fails against the code: /);
    assert.equal(bug.range.start.line, 4, 'expected the warning on the declaration of finalPrice');
    const evidence = bug.relatedInformation?.[0]?.location;
    assert.equal(evidence?.uri.toString(), uri.toString());
    assert.equal(evidence?.range.start.line, 2, 'expected the related information on the documented requirement');
  });

  it('hides the warning while discount.ts is dirty or editor insights are off', async () => {
    const uri = discountUri();
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    assert.equal(testforgeDiagnostics(uri).length, 1, 'expected the warning from the finalPrice demo run');

    // Unsaved changes make the run stale; reverting them makes it fresh again. Nothing is saved.
    assert.ok(await editor.edit((b) => b.insert(new vscode.Position(0, 0), ' ')));
    try {
      await waitFor('the warning to disappear while discount.ts is dirty', () => (testforgeDiagnostics(uri).length === 0 ? true : undefined));
    } finally {
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
    await waitFor('the warning to return after the revert', () => (testforgeDiagnostics(uri).length === 1 ? true : undefined));

    // User settings of the test profile, not the fixture workspace.
    const config = vscode.workspace.getConfiguration('testforge');
    await config.update('editorInsights', false, vscode.ConfigurationTarget.Global);
    try {
      await waitFor('the warning to disappear with editorInsights off', () => (testforgeDiagnostics(uri).length === 0 ? true : undefined));
    } finally {
      await config.update('editorInsights', undefined, vscode.ConfigurationTarget.Global);
    }
    await waitFor('the warning to return with editorInsights on', () => (testforgeDiagnostics(uri).length === 1 ? true : undefined));
  });

  it('copies the finalPrice run to the clipboard as a Markdown proof', async () => {
    const md = await vscode.commands.executeCommand<string | undefined>('testforge.copyProof');
    assert.ok(md, 'expected copyProof to return the Markdown it copied');
    assert.equal(await vscode.env.clipboard.readText(), md);
    assert.match(md, /^### TestForge proof: `finalPrice` in `src\/discount\.ts`\n\n> DEMO run/);
    assert.match(md, /\*\*Possible bugs\*\*[^\n]*\n- member order of exactly 100 costs 90: /);
    assert.doesNotMatch(md, /STALE/);
  });

  it('previews the generated tests as one read-only document', async () => {
    await vscode.commands.executeCommand('testforge.previewTests');
    const doc = await waitFor('the preview document', () => {
      const d = vscode.window.activeTextEditor?.document;
      return d?.uri.scheme === 'testforge-preview' ? d : undefined;
    });
    assert.match(doc.uri.path, /\/src\/\[NEW FILE, DEMO\] discount\.testforge\.[^/]+\.test\.ts$/);
    assert.equal(doc.languageId, 'typescript');
    assert.match(doc.getText(), /finalPrice/);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  it('contributes both chat tools to vscode.lm.tools', async () => {
    await getExtension().activate();
    for (const name of ['testforge_auditTests', 'testforge_generateAndVerify']) {
      await waitFor(`${name} in vscode.lm.tools`, () => (vscode.lm.tools.some((t) => t.name === name) ? true : undefined));
    }
  });

  it('the audit chat tool scores the existing tests of isEligible', async function () {
    this.timeout(180_000);
    const api = await getExtension().activate();
    // No chat request: VS Code runs prepareInvocation, then invoke. The extension omits the
    // confirmation under TESTFORGE_TEST_CONSENT so no dialog blocks the headless host.
    const result = await vscode.lm.invokeTool('testforge_auditTests', { input: { filePath: 'src/age.ts', functionName: 'isEligible' }, toolInvocationToken: undefined });
    const text = result.content.map((p) => (p as { value?: unknown }).value).filter((v) => typeof v === 'string').join('');
    assert.match(text, /Mutation score of the existing tests: 1\/3 detected/, text);
    assert.match(text, /line 3: >= → >/, text);
    // The run is saved and shown like a command run.
    const report = api?.lastReport() as { mode?: unknown; sourceFile?: unknown } | undefined;
    assert.equal(report?.mode, 'audit');
    assert.equal(report?.sourceFile, 'src/age.ts');
  });
});
