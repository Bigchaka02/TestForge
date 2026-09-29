// Model provider boundary. Providers return raw text only; they never write files
// or run tools. The pipeline validates everything they return.
export interface ModelProvider {
  readonly label: string; // shown in reports, e.g. "copilot/gpt-4o" or "DEMO fake model"
  readonly isFake: boolean;
  /** Sends one request. `history` holds prior user/assistant turns for the correction retry. */
  complete(prompt: string, history: { role: 'user' | 'assistant'; text: string }[], signal: AbortSignal): Promise<string>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: 'no-model' | 'denied' | 'quota' | 'cancelled' | 'too-large' | 'stream' | 'other',
  ) {
    super(message);
  }
}
