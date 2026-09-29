// Validates untrusted model output into data-only case records.
import { CaseRecord, JsonValue, LIMITS, ModelCasePlan, ProposedCase, modelCasePlanSchema } from '../core/types';
import { canonicalJson, sha256 } from '../core/util';

const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Checks a value is plain JSON within the depth/size limits. Returns a reason or undefined. */
export function checkJsonValue(value: unknown, depth = 0): string | undefined {
  if (depth > LIMITS.jsonDepth) return `nesting deeper than ${LIMITS.jsonDepth}`;
  if (value === null || typeof value === 'boolean') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? undefined : 'non-finite number';
  if (typeof value === 'string') return value.length > LIMITS.jsonString ? `string longer than ${LIMITS.jsonString}` : undefined;
  if (Array.isArray(value)) {
    if (value.length > LIMITS.jsonArray) return `array longer than ${LIMITS.jsonArray}`;
    for (const v of value) {
      const r = checkJsonValue(v, depth + 1);
      if (r) return r;
    }
    return undefined;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [k, v] of Object.entries(value)) {
      if (PROTO_KEYS.has(k)) return `forbidden key "${k}"`;
      const r = checkJsonValue(v, depth + 1);
      if (r) return r;
    }
    return undefined;
  }
  return `unsupported value type ${typeof value}`;
}

/** Accepts exactly one JSON value, optionally inside one outer ```json fence. */
export function parseModelText(text: string): unknown {
  if (Buffer.byteLength(text) > LIMITS.maxResponseBytes) throw new Error(`response larger than ${LIMITS.maxResponseBytes / 1024} KiB`);
  let body = text.trim();
  const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n```$/.exec(body);
  if (fence) body = fence[1].trim();
  // JSON.parse creates own "__proto__" keys rather than setting prototypes; checkJsonValue rejects them.
  return JSON.parse(body) as unknown;
}

export interface EvidenceFile {
  id: string; // e.g. F1
  rel: string;
  lines: string[];
}

function checkEvidence(c: ProposedCase, files: Map<string, EvidenceFile>): string | undefined {
  if (c.basis !== 'inferred' && c.evidence.length === 0) return `basis "${c.basis}" needs evidence; unsupported expectations must be "inferred"`;
  for (const e of c.evidence) {
    const f = files.get(e.fileId);
    if (!f) return `evidence cites unknown file ${e.fileId}`;
    if (e.endLine < e.startLine || e.endLine > f.lines.length) return `evidence lines ${e.startLine}-${e.endLine} are outside ${f.rel}`;
    const span = f.lines.slice(e.startLine - 1, e.endLine).join('\n');
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    if (!norm(span).includes(norm(e.excerpt))) return `evidence excerpt not found in ${f.rel}:${e.startLine}-${e.endLine}`;
  }
  return undefined;
}

export const caseFingerprint = (c: Pick<ProposedCase, 'args' | 'expectation'>) => sha256(canonicalJson({ args: c.args, expectation: c.expectation })).slice(0, 16);
const inputFingerprint = (c: Pick<ProposedCase, 'args'>) => sha256(canonicalJson(c.args)).slice(0, 16);

export interface ValidationResult {
  plan: ModelCasePlan;
  cases: CaseRecord[];
  duplicatesSkipped: number;
}

/**
 * Validates a parsed plan. Throws (to trigger the correction retry) when the envelope is
 * invalid; individual bad cases are kept as visible "rejected" records.
 */
export function validatePlan(
  raw: unknown,
  opts: { exportName: string; files: EvidenceFile[]; known: Set<string>; existing: CaseRecord[]; maxAccepted: number },
): ValidationResult {
  const parsed = modelCasePlanSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`schema: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const plan = parsed.data;
  if (plan.exportName !== opts.exportName) throw new Error(`exportName must be "${opts.exportName}"`);
  const files = new Map(opts.files.map((f) => [f.id, f]));
  const cases: CaseRecord[] = [];
  let duplicatesSkipped = 0;
  const seen = new Set(opts.known);
  const byInput = new Map(opts.existing.filter((c) => c.status === 'accepted').map((c) => [inputFingerprint(c), c]));
  let accepted = opts.existing.filter((c) => c.status === 'accepted').length;

  for (const c of plan.cases) {
    const fingerprint = caseFingerprint(c);
    const record: CaseRecord = { ...c, id: `tf-${fingerprint.slice(0, 8)}`, fingerprint, status: 'accepted' };
    const jsonProblem = [...c.args, c.expectation.kind === 'returns' ? c.expectation.value : null].map((v) => checkJsonValue(v, 1)).find(Boolean);
    const evidenceProblem = checkEvidence(c, files);
    if (seen.has(fingerprint)) {
      duplicatesSkipped++;
      continue;
    }
    seen.add(fingerprint);
    if (jsonProblem) Object.assign(record, { status: 'rejected', rejectReason: jsonProblem });
    else if (Buffer.byteLength(JSON.stringify(c)) > LIMITS.caseBytes) Object.assign(record, { status: 'rejected', rejectReason: `case larger than ${LIMITS.caseBytes / 1024} KiB` });
    else if (evidenceProblem) Object.assign(record, { status: 'rejected', rejectReason: evidenceProblem });
    else if (byInput.has(inputFingerprint(c))) {
      const other = byInput.get(inputFingerprint(c))!;
      Object.assign(record, { status: 'conflict', rejectReason: `same inputs as ${other.id} but a different expectation` });
    } else if (accepted >= opts.maxAccepted) Object.assign(record, { status: 'rejected', rejectReason: `case limit (${opts.maxAccepted}) reached` });
    if (record.status === 'accepted') {
      accepted++;
      byInput.set(inputFingerprint(c), record);
    }
    cases.push(record);
  }
  return { plan, cases, duplicatesSkipped };
}

/** Values the renderer embeds are always re-checked here, independent of the validator. */
export function assertJson(value: JsonValue): void {
  const r = checkJsonValue(value);
  if (r) throw new Error(r);
}
