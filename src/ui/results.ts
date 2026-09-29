// Native TreeView with five groups. Status is always spelled out in text, never color only.
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CaseRecord, MutationOutcome, MutationRecord, SuiteScore } from '../core/types';
import type { StoredRun } from '../storage/apply';

type Node = { label: string; description?: string; tooltip?: string; icon?: string; children?: Node[]; command?: vscode.Command };

const WORD: Record<MutationOutcome, string> = { killed: 'DETECTED', survived: 'MISSED', invalid: 'INVALID', timeout: 'TIMEOUT', error: 'ERROR', 'not-run': 'NOT RUN' };

const caseWord = (c: CaseRecord) =>
  c.status !== 'accepted' ? c.status.toUpperCase() : c.originalOutcome === 'passed' ? 'PASS' : c.originalOutcome === 'failed' ? 'FAIL' : c.originalOutcome === 'timeout' ? 'TIMEOUT' : 'NOT RUN';

const fmtScore = (s?: SuiteScore) => (!s ? 'n/a' : s.rate === null ? `N/A (0 valid, ${s.excluded} excluded)` : `${s.killed}/${s.killed + s.survived} detected${s.excluded ? `, ${s.excluded} excluded` : ''}`);

export class ResultsProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private run: StoredRun | undefined;
  private stale: string[] = [];

  show(run: StoredRun | undefined, stale: string[] = []): void {
    this.run = run;
    this.stale = stale;
    this.emitter.fire(undefined);
  }

  current(): StoredRun | undefined {
    return this.run;
  }

  getTreeItem(n: Node): vscode.TreeItem {
    const item = new vscode.TreeItem(n.label, n.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    item.description = n.description;
    item.tooltip = n.tooltip;
    item.command = n.command;
    if (n.icon) item.iconPath = new vscode.ThemeIcon(n.icon);
    return item;
  }

  getChildren(n?: Node): Node[] {
    if (n) return n.children ?? [];
    if (!this.run) return [{ label: 'No run yet. Use "Generate & Verify Tests" above an exported function.' }];
    return this.build(this.run);
  }

  private open(rel: string, line: number): vscode.Command {
    const uri = vscode.Uri.file(path.join(this.run!.root, rel));
    return { title: 'Open', command: 'vscode.open', arguments: [uri, { selection: new vscode.Range(line - 1, 0, line - 1, 0) }] };
  }

  private build(run: StoredRun): Node[] {
    const r = run.report;
    const elapsed = r.finishedAt ? `${((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000).toFixed(1)}s` : 'running';
    const runNodes: Node[] = [
      { label: `Status: ${r.status.toUpperCase()}`, description: r.demo ? 'DEMO (fake model)' : undefined, icon: r.status === 'completed' ? 'pass' : 'warning' },
      { label: `Function: ${r.exportName}`, description: r.sourceFile, command: this.open(r.sourceFile, 1) },
      { label: `Model: ${r.model}`, description: `${r.modelRequests} request(s)` },
      { label: `Elapsed: ${elapsed}`, description: `run ${r.runId}` },
      { label: `Scope: ${r.scope}` },
      { label: `Context sent: ${r.contextFiles.length} file(s)`, tooltip: r.contextFiles.join('\n') },
    ];
    if (r.failure) runNodes.push({ label: `Stopped: ${r.failure.message}`, tooltip: r.failure.detail, icon: 'error' });
    if (this.stale.length) runNodes.push({ label: 'STALE: Apply is disabled', description: this.stale.join('; '), tooltip: this.stale.join('\n'), icon: 'history' });
    if (run.appliedHash) runNodes.push({ label: `Applied: ${r.generatedTestPath}`, icon: 'check' });
    if (r.generatedTest) runNodes.push({ label: 'Preview generated test file', icon: 'eye', command: { title: 'Preview', command: 'testforge.previewTests' } });
    if (r.cleanup !== 'done') runNodes.push({ label: `Cleanup: ${r.cleanup.toUpperCase()}`, icon: 'warning' });

    const caseNodes: Node[] = r.cases.map((c) => {
      const ev = c.evidence[0];
      const evFile = ev ? r.contextFiles[Number(ev.fileId.slice(1)) - 1] : undefined;
      return {
        label: `[${caseWord(c)}] ${c.title}`,
        description: `${c.basis} · ${c.category}`,
        tooltip: [c.rationale, ...c.evidence.map((e) => `${e.fileId} ${e.startLine}-${e.endLine}: ${e.excerpt}`), c.rejectReason, c.failureMessage].filter(Boolean).join('\n'),
        icon: caseWord(c) === 'PASS' ? 'pass' : 'circle-slash',
        command: evFile && ev ? this.open(evFile, ev.startLine) : undefined,
      };
    });
    if (r.duplicatesSkipped) caseNodes.push({ label: `${r.duplicatesSkipped} duplicate case(s) skipped` });
    for (const q of r.unresolvedQuestions) caseNodes.push({ label: `Question: ${q}`, icon: 'question' });

    const s = r.scores;
    const testNodes: Node[] = [
      { label: `Baseline runs: ${r.baselineRuns.join(', ') || 'none (no existing tests)'}`, tooltip: r.baselineTests.join('\n') },
      { label: `Candidate runs: ${r.candidateRuns.join(', ') || 'not run'}` },
      { label: `Existing tests: ${fmtScore(s.baseline)}` },
      { label: `With generated tests: ${fmtScore(s.generated)}` },
    ];
    if (s.comparison) {
      const c = s.comparison;
      testNodes.push({ label: `Shared comparison: ${c.before}/${c.denominator} → ${c.after}/${c.denominator} (${c.after - c.before >= 0 ? '+' : ''}${c.after - c.before})`, description: c.excluded ? `${c.excluded} excluded` : undefined });
    }

    const mutNodes: Node[] = r.mutations.map((m: MutationRecord) => ({
      label: `Line ${m.line}: ${m.original} → ${m.replacement}`,
      description: `${m.baseline ? `existing: ${WORD[m.baseline]} · ` : ''}with generated: ${m.generated ? WORD[m.generated] : 'NOT RUN'}`,
      tooltip: [m.family, m.detectingTests.length ? `Detected by: ${m.detectingTests.join(', ')}` : '', m.note ?? ''].filter(Boolean).join('\n'),
      icon: m.generated === 'killed' ? 'shield' : 'debug-breakpoint-unverified',
      command: { title: 'Show mutation', command: 'testforge.showMutation', arguments: [m.id] },
    }));
    if (!mutNodes.length) mutNodes.push({ label: 'No mutation results' });

    return [
      { label: 'Run', children: runNodes },
      { label: 'Cases', children: caseNodes.length ? caseNodes : [{ label: 'No cases' }] },
      { label: 'Test Results', children: testNodes },
      { label: 'Mutation Checks', children: mutNodes },
      { label: 'Limitations', children: r.limitations.map((l) => ({ label: l, tooltip: l })) },
    ];
  }
}
