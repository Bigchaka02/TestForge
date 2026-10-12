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
