// Real provider: VS Code Language Model API. No API keys, no hardcoded model family.
import * as vscode from 'vscode';
import { LIMITS } from '../core/types';
import { ModelProvider, ProviderError } from './provider';

const OUTPUT_RESERVE_TOKENS = 4_000;

export const modelLabel = (m: vscode.LanguageModelChat) => `${m.vendor}/${m.family} (${m.name})`;

export class VsCodeLmProvider implements ModelProvider {
  readonly isFake = false;
  readonly label: string;

  constructor(private readonly model: vscode.LanguageModelChat) {
    this.label = modelLabel(model);
  }

  async complete(prompt: string, history: { role: 'user' | 'assistant'; text: string }[], signal: AbortSignal): Promise<string> {
    const messages = [
      ...history.map((h) => (h.role === 'user' ? vscode.LanguageModelChatMessage.User(h.text) : vscode.LanguageModelChatMessage.Assistant(h.text))),
      vscode.LanguageModelChatMessage.User(prompt),
    ];
    const cts = new vscode.CancellationTokenSource();
    const onAbort = () => cts.cancel();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      let tokens = 0;
      for (const m of messages) tokens += await this.model.countTokens(m, cts.token);
      if (tokens > this.model.maxInputTokens - OUTPUT_RESERVE_TOKENS) {
        throw new ProviderError(`Context needs ${tokens} tokens but ${this.label} accepts ${this.model.maxInputTokens} (with ${OUTPUT_RESERVE_TOKENS} reserved for the answer).`, 'too-large');
      }
      const response = await this.model.sendRequest(messages, { justification: 'TestForge sends the selected function and its local imports to propose test cases.' }, cts.token);
      let text = '';
      for await (const chunk of response.text) {
        text += chunk;
        if (Buffer.byteLength(text) > LIMITS.maxResponseBytes) {
          cts.cancel();
          throw new ProviderError(`The response exceeded ${LIMITS.maxResponseBytes / 1024} KiB and was stopped.`, 'too-large');
        }
      }
      return text;
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if (signal.aborted || cts.token.isCancellationRequested) throw new ProviderError('The model request was cancelled.', 'cancelled');
      if (e instanceof vscode.LanguageModelError) {
        const code = e.code === vscode.LanguageModelError.NoPermissions.name ? 'denied' : e.code === vscode.LanguageModelError.Blocked.name ? 'quota' : e.code === vscode.LanguageModelError.NotFound.name ? 'no-model' : 'other';
        throw new ProviderError(`${e.message} (${e.code})`, code);
      }
      throw new ProviderError(`The response stream failed: ${(e as Error).message}`, 'stream');
    } finally {
      signal.removeEventListener('abort', onAbort);
      cts.dispose();
    }
  }
}
