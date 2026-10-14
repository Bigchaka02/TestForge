// Which run a chat tool call was confirmed for. vscode-free, so unit tests can check the rules.
//
// VS Code calls prepareInvocation before every invoke, but a prepare is not always followed by an
// invoke (the user can decline), and a prepare that shows no confirmation is followed by an invoke
// without asking. So only the latest prepare of the same call counts, and only once.

export interface ToolCall {
  mode: string;
  filePath?: unknown;
  functionName?: unknown;
}

const callKey = (c: ToolCall) => JSON.stringify([c.mode, c.filePath ?? null, c.functionName ?? null]);

export class ToolConfirmations {
  private readonly last = new Map<string, string>();

  /** A prepare that showed a confirmation for `run` (mode, function, model and files). */
  confirm(call: ToolCall, run: string): void {
    this.last.set(callKey(call), run);
  }

  /** A prepare that showed no confirmation: the next invoke of this call must not run. */
  clear(call: ToolCall): void {
    this.last.delete(callKey(call));
  }

  /** In invoke: true when `run` is what the latest prepare of this call confirmed. Uses the confirmation up. */
  take(call: ToolCall, run: string): boolean {
    const key = callKey(call);
    const ok = this.last.get(key) === run;
    this.last.delete(key);
    return ok;
  }
}
