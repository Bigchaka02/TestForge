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
    const r = report as { schemaVersion?: unknown; status?: unknown };
    assert.equal(r.schemaVersion, 1);
    assert.equal(typeof r.status, 'string');
  });
});
