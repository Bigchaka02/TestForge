// Contracts shared by every module. Nothing here imports `vscode`.
import { z } from 'zod';

export const LIMITS = {
  maxSourceFiles: 10,
  maxTestFiles: 5,
  maxFileBytes: 64 * 1024,
  maxContextBytes: 128 * 1024,
  initialCases: 8,
  maxCases: 12,
  maxModelRequests: 3,
  modelDeadlineMs: 45_000,
  maxResponseBytes: 128 * 1024,
  defaultMutations: 8,
  maxMutations: 20,
  testTimeoutMs: 2_000,
  processDeadlineMs: 15_000,
  globalDeadlineMs: 180_000,
  maxOutputBytes: 1024 * 1024,
  historyRuns: 10,
  historyDays: 7,
  jsonDepth: 8,
  jsonArray: 100,
  jsonString: 4_000,
  titleLength: 200,
  caseBytes: 8 * 1024,
} as const;

export type Limits = { -readonly [K in keyof typeof LIMITS]: number };

export const CONSENT_POLICY_VERSION = 1;

export type Stage =
  | 'idle'
  | 'preflight'
  | 'snapshotting'
  | 'checking-baseline'
  | 'generating'
  | 'validating-candidates'
  | 'checking-mutations'
  | 'improving'
  | 'reporting'
  | 'completed';

export type TerminalStatus = 'completed' | 'unsupported' | 'blocked' | 'failed' | 'cancelled' | 'partial';

export type FailureKind =
  | 'unsupported' // input outside the support matrix
  | 'blocked' // trust, consent, dirty files, missing model
  | 'setup' // missing/unsupported toolchain in the target project
  | 'original-type-error' // target project does not type-check
  | 'baseline-failure' // pre-existing failing test
  | 'unstable' // repeated runs disagree
  | 'provider' // model unavailable, quota, denial, stream error
  | 'invalid-response' // model output failed validation after retry
  | 'infrastructure' // runner crash, missing report, collection error
  | 'cancelled'
  | 'deadline';

export class TestForgeError extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

// ---- Model response schema, version 1 (data only) ----

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const jsonValue = z.custom<JsonValue>(() => true); // shape checked by checkJsonValue()

export const evidenceRefSchema = z.strictObject({
  fileId: z.string().max(20),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  excerpt: z.string().min(1).max(LIMITS.jsonString),
});

export const proposedCaseSchema = z.strictObject({
  title: z.string().min(1).max(LIMITS.titleLength),
  category: z.enum(['normal', 'boundary', 'empty', 'invalid', 'error']),
  args: z.array(jsonValue).max(LIMITS.jsonArray),
  expectation: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('returns'), value: jsonValue }),
    z.strictObject({
      kind: z.literal('throws'),
      errorName: z.string().max(100).optional(),
      messageIncludes: z.string().max(LIMITS.jsonString).optional(),
    }),
  ]),
  basis: z.enum(['documented', 'existing-test', 'inferred']),
  evidence: z.array(evidenceRefSchema).max(5),
  rationale: z.string().max(LIMITS.jsonString),
});

export const modelCasePlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  exportName: z.string(),
  cases: z.array(proposedCaseSchema).max(LIMITS.maxCases),
  unresolvedQuestions: z.array(z.string().max(LIMITS.jsonString)).max(10),
});

export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
export type ProposedCase = z.infer<typeof proposedCaseSchema>;
export type ModelCasePlan = z.infer<typeof modelCasePlanSchema>;

// ---- Run records ----

export type TestStatus = 'passed' | 'failed' | 'skipped';

export interface TestResult {
  file: string; // relative to the copy root
  title: string;
  status: TestStatus;
  timedOut: boolean;
  message?: string;
}

export interface SuiteRun {
  status: 'completed' | 'timeout' | 'error' | 'cancelled';
  tests: TestResult[];
  error?: string;
}

export interface CaseRecord extends ProposedCase {
  id: string;
  fingerprint: string;
  status: 'accepted' | 'duplicate' | 'conflict' | 'rejected';
  rejectReason?: string;
  originalOutcome?: 'passed' | 'failed' | 'timeout' | 'not-run';
  failureMessage?: string;
}

export type MutationOutcome = 'killed' | 'survived' | 'invalid' | 'timeout' | 'error' | 'not-run';

export interface Mutation {
  id: string;
  family: 'relational-boundary' | 'strict-equality' | 'boolean-return';
  file: string; // relative path
  start: number;
  end: number;
  line: number; // 1-based
  column: number; // 1-based
  original: string;
  replacement: string;
}

export interface MutationRecord extends Mutation {
  baseline?: MutationOutcome; // absent when there is no baseline suite
  generated?: MutationOutcome;
  detectingTests: string[];
  note?: string;
}

export interface SuiteScore {
  killed: number;
  survived: number;
  excluded: number;
  rate: number | null; // null means N/A
}

export interface Comparison {
  denominator: number;
  before: number;
  after: number;
  excluded: number;
}

export interface RunReport {
  schemaVersion: 1;
  runId: string;
  status: TerminalStatus;
  stage: Stage;
  demo: boolean;
  scope: 'selected-module test scope';
  exportName: string;
  sourceFile: string; // relative
  inputHashes: Record<string, string>; // relative path -> sha256
  model: string;
  toolVersions: Record<string, string>;
  startedAt: string;
  finishedAt?: string;
  stageMs: Partial<Record<Stage, number>>;
  contextFiles: string[];
  contextExclusions: string[];
  baselineTests: string[];
  cases: CaseRecord[];
  duplicatesSkipped: number;
  unresolvedQuestions: string[];
  generatedTestPath?: string; // relative path it would be applied to
  generatedTest?: string; // rendered source
  baselineRuns: SuiteRun['status'][];
  candidateRuns: SuiteRun['status'][];
  mutations: MutationRecord[];
  scores: { baseline?: SuiteScore; generated?: SuiteScore; comparison?: Comparison };
  modelRequests: number;
  limitations: string[];
  failure?: { kind: FailureKind; message: string; detail?: string };
  cleanup: 'done' | 'failed' | 'pending';
}
