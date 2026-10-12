// The shown run in the editor: gutter markers with hovers on mutated lines, a score CodeLens
// above the target function and "possible bug" warnings. Everything is hidden while the run is
// stale (changed or unsaved inputs) and when `testforge.editorInsights` is off.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LineInsight, lineInsights, possibleBugs, scoreSummary, targetLine } from '../report/insights';
import type { StoredRun } from '../storage/apply';

/** What is on screen for a fresh run. */
interface View {
  source: vscode.Uri;
  lines: LineInsight[];
  summary?: string;
  decl: vscode.Range; // declaration line of the target function
}

const fileUri = (run: StoredRun, rel: string) => vscode.Uri.file(path.join(run.root, rel));

export class EditorInsights implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly lensEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensEmitter.event;
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('testforge');
  private readonly markers: Record<LineInsight['state'], vscode.TextEditorDecorationType>;
  private readonly disposable: vscode.Disposable;
  private run: StoredRun | undefined;
  private fresh = false;
  private inputs = new Set<string>(); // URIs of the run's input files
  private view: View | undefined;

  /** `refresh` re-checks freshness and calls show() again (showRun in extension.ts). */
  constructor(extensionUri: vscode.Uri, refresh: () => void) {
    const marker = (icon: string, color: string) =>
      vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.joinPath(extensionUri, 'media', icon),
        gutterIconSize: 'contain',
        overviewRulerColor: new vscode.ThemeColor(color),
        overviewRulerLane: vscode.OverviewRulerLane.Left,
      });
    this.markers = { protected: marker('protected.svg', 'testing.iconPassed'), exposed: marker('exposed.svg', 'editorWarning.foreground') };
    this.disposable = vscode.Disposable.from(
      this.lensEmitter,
      this.diagnostics,
      this.markers.protected,
      this.markers.exposed,
      vscode.languages.registerCodeLensProvider({ language: 'typescript', scheme: 'file' }, this),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('testforge.editorInsights') && this.render()),
      // An edit makes the run stale at once; undo back to the saved text or a reload from disk can make it fresh again.
      vscode.workspace.onDidChangeTextDocument((e) => this.inputs.has(e.document.uri.toString()) && (this.fresh || !e.document.isDirty) && refresh()),
    );
  }

  show(run: StoredRun | undefined, stale: string[]): void {
    this.run = run;
    this.fresh = !!run && !stale.length;
    this.inputs = new Set(run ? Object.keys(run.report.inputHashes).map((rel) => fileUri(run, rel).toString()) : []);
    this.render();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const v = this.view;
    if (!v?.summary || doc.uri.toString() !== v.source.toString()) return [];
    const line = v.decl.start.line;
    return [new vscode.CodeLens(new vscode.Range(line, 0, line, 0), { title: v.summary, command: 'testforge.results.focus', tooltip: 'Show the TestForge Results view' })];
  }

  dispose(): void {
    this.disposable.dispose();
  }

  private render(): void {
    const run = this.fresh && vscode.workspace.getConfiguration('testforge').get<boolean>('editorInsights', true) ? this.run : undefined;
    this.view = undefined;
    this.diagnostics.clear();
    if (run) {
      const source = fileUri(run, run.report.sourceFile);
      let text = '';
      try {
        text = fs.readFileSync(source.fsPath, 'utf8'); // same bytes the run analyzed, since it is fresh
      } catch {
        // an unreadable source makes the run stale on the next refresh
      }
      const line = (targetLine(run.report, text) ?? 1) - 1;
      const lineText = text.split(/\r?\n/)[line] ?? '';
      const decl = new vscode.Range(line, lineText.search(/\S|$/), line, lineText.length);
      this.view = { source, lines: lineInsights(run.report), summary: scoreSummary(run.report), decl };
      const bugs = possibleBugs(run.report).map((b) => {
        const d = new vscode.Diagnostic(decl, b.message, vscode.DiagnosticSeverity.Warning);
        d.source = 'TestForge';
        if (b.evidence) d.relatedInformation = [new vscode.DiagnosticRelatedInformation(new vscode.Location(fileUri(run, b.evidence.file), new vscode.Position(b.evidence.line - 1, 0)), b.evidence.excerpt)];
        return d;
      });
      if (bugs.length) this.diagnostics.set(source, bugs);
    }
    this.decorate();
    this.lensEmitter.fire();
  }

  private decorate(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const doc = editor.document;
      const lines = this.view && doc.uri.toString() === this.view.source.toString() ? this.view.lines.filter((l) => l.line <= doc.lineCount) : [];
      for (const state of ['protected', 'exposed'] as const) {
        // Untrusted Markdown (the default): no command links, no HTML.
        editor.setDecorations(this.markers[state], lines.filter((l) => l.state === state).map((l) => ({ range: doc.lineAt(l.line - 1).range, hoverMessage: new vscode.MarkdownString(l.hover) })));
      }
    }
  }
}
