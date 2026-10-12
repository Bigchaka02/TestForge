// Extension-host smoke tests. They run inside a real VS Code with the
// workspace folder fixtures/sample (see .vscode-test.mjs).
import * as assert from 'node:assert/strict';
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
  });

  it('runDemo on finalPrice warns about the documented case the code fails', async () => {
    const api = await getExtension().activate();
    const uri = discountUri();
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    // The same arguments the CodeLens above finalPrice passes.
    await vscode.commands.executeCommand('testforge.runDemo', uri, 'finalPrice');
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
});
