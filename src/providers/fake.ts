// Deterministic fake provider for automated tests and the labeled demo mode.
// It returns canned descriptors for the bundled fixtures and cites evidence by
// locating excerpts in the numbered context it receives. It is NOT an AI model.
import type { ModelProvider } from './provider';

type Canned = { title: string; category: string; args: unknown[]; expectation: unknown; basis: string; excerpt?: string; rationale: string };

const CANNED: Record<string, Canned[]> = {
  isEligible: [
    { title: 'age 18 is eligible (boundary)', category: 'boundary', args: [18], expectation: { kind: 'returns', value: true }, basis: 'documented', excerpt: 'Eligible when age is at least 18.', rationale: '"at least 18" includes 18 itself.' },
  ],
  finalPrice: [
    { title: 'member order of exactly 100 costs 90', category: 'boundary', args: [100, true], expectation: { kind: 'returns', value: 90 }, basis: 'documented', excerpt: 'Requirement: an order of exactly 100 by a member costs 90.', rationale: 'Stated requirement.' },
    { title: 'member order of 200 costs 180', category: 'normal', args: [200, true], expectation: { kind: 'returns', value: 180 }, basis: 'documented', excerpt: 'Members get 10% off orders of 100 or more.', rationale: '10% off 200.' },
  ],
  clamp: [
    { title: 'value inside the range is unchanged', category: 'normal', args: [5, 10], expectation: { kind: 'returns', value: 5 }, basis: 'inferred', rationale: 'Clamping leaves in-range values alone.' },
    { title: 'negative value clamps to 0', category: 'boundary', args: [-3, 10], expectation: { kind: 'returns', value: 0 }, basis: 'documented', excerpt: 'Clamp value into [MIN, max].', rationale: 'Lower bound is MIN = 0.' },
    { title: 'value equal to max stays max', category: 'boundary', args: [10, 10], expectation: { kind: 'returns', value: 10 }, basis: 'documented', excerpt: 'Clamp value into [MIN, max].', rationale: 'Upper bound is inclusive.' },
    { title: 'max below 0 throws RangeError', category: 'error', args: [3, -1], expectation: { kind: 'throws', errorName: 'RangeError', messageIncludes: 'max must be' }, basis: 'documented', excerpt: 'Throws RangeError when max is below MIN.', rationale: 'Documented error.' },
  ],
  countDown: [
    { title: 'counts down from 3', category: 'normal', args: [3], expectation: { kind: 'returns', value: 3 }, basis: 'inferred', rationale: 'Three steps to reach zero.' },
    { title: 'negative input', category: 'invalid', args: [-1], expectation: { kind: 'returns', value: 0 }, basis: 'inferred', rationale: 'Probes the documented hang.' },
  ],
  joinWords: [
    { title: 'empty list gives empty string', category: 'empty', args: [[]], expectation: { kind: 'returns', value: '' }, basis: 'inferred', rationale: 'Nothing to join.' },
    { title: 'two words joined by a space', category: 'normal', args: [['a', 'b']], expectation: { kind: 'returns', value: 'a b' }, basis: 'documented', excerpt: 'Joins words with a single space.', rationale: 'Documented separator.' },
  ],
};

/** Finds an excerpt in the numbered context blocks of the prompt. */
function locate(prompt: string, excerpt: string): { fileId: string; startLine: number; endLine: number; excerpt: string } | undefined {
  let fileId = '';
  for (const line of prompt.split('\n')) {
    const header = /^=== (F\d+): /.exec(line);
    if (header) fileId = header[1];
    const numbered = /^(\d+)\| (.*)$/.exec(line);
    if (fileId && numbered && numbered[2].includes(excerpt)) return { fileId, startLine: Number(numbered[1]), endLine: Number(numbered[1]), excerpt };
  }
  return undefined;
}

export class FakeProvider implements ModelProvider {
  readonly label = 'DEMO fake model (no AI)';
  readonly isFake = true;
  requests = 0;

  constructor(private readonly override?: (prompt: string, attempt: number) => string) {}

  async complete(prompt: string, history: { role: 'user' | 'assistant'; text: string }[], signal: AbortSignal): Promise<string> {
    this.requests++;
    if (signal.aborted) throw new Error('cancelled');
    if (this.override) return this.override(prompt, history.length);
    const first = history.length ? history[0].text : prompt;
    const exportName = /exported TypeScript function `([^`]+)`/.exec(first)?.[1] ?? '';
    const canned = CANNED[exportName] ?? [];
    const cases = canned.map(({ excerpt, ...c }) => {
      const ref = excerpt ? locate(first, excerpt) : undefined;
      return { ...c, basis: ref ? c.basis : 'inferred', evidence: ref ? [ref] : [] };
    });
    const unresolvedQuestions = canned.length ? [] : [`The demo provider has no canned cases for ${exportName}.`];
    return '```json\n' + JSON.stringify({ schemaVersion: 1, exportName, cases, unresolvedQuestions }, null, 2) + '\n```';
  }
}
