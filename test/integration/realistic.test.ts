// Full pipeline runs against fixtures/realistic: a CommonJS package whose code imports a
// node: built-in and a local package (file: dependency), with baseline tests found in test/
// and __tests__/ that use describe, hooks, .each, .skip, .todo and vi.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { runPipeline, PipelineInput } from '../../src/core/pipeline';
import type { RunReport } from '../../src/core/types';
import { sha256 } from '../../src/core/util';
import { FakeProvider } from '../../src/providers/fake';

const ROOT = path.resolve(__dirname, '../../fixtures/realistic');
const MODULES = path.join(ROOT, 'node_modules');

/** Hashes of every file in the fixture except node_modules. */
function hashTree(dir: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (r === 'node_modules') continue;
    if (d.isDirectory()) Object.assign(out, hashTree(dir, r));
    else if (d.isFile()) out[r] = sha256(fs.readFileSync(path.join(dir, r)));
  }
  return out;
}

/** The fake provider, recording every prompt it receives. */
class RecordingProvider extends FakeProvider {
  prompts: string[] = [];
  override async complete(prompt: string, history: { role: 'user' | 'assistant'; text: string }[], signal: AbortSignal): Promise<string> {
    this.prompts.push(prompt);
    return super.complete(prompt, history, signal);
  }
}

let before: Record<string, string>;
let moduleEntries: string[];
const tmpDirs: string[] = [];
beforeAll(() => {
  before = hashTree(ROOT);
  moduleEntries = fs.readdirSync(MODULES).sort();
});
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

const newTmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** A temporary project: the fixture's package.json, tsconfig.json and src/quota.ts, the given files, and a link to the fixture's node_modules. */
function quotaProject(files: Record<string, string>): string {
  const root = newTmp('testforge-it-quota-');
  const all = { 'package.json': read('package.json'), 'tsconfig.json': read('tsconfig.json'), 'src/quota.ts': read('src/quota.ts'), ...files };
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  fs.symlinkSync(MODULES, path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return root;
}

async function run(file: string, exportName: string, over: Partial<Omit<PipelineInput, 'mode' | 'provider'>> = {}): Promise<{ report: RunReport; provider: RecordingProvider }> {
  const tmpBase = newTmp('testforge-it-realistic-');
  const provider = new RecordingProvider();
  const root = over.root ?? ROOT;
  const report = await runPipeline({ root, sourceAbs: path.join(root, file), exportName, provider, tmpBase, ...over });
  expect(report.cleanup).toBe('done');
  expect(fs.readdirSync(tmpBase)).toEqual([]);
  return { report, provider };
}

describe('pipeline on fixtures/realistic', () => {
  test('the fixture is a CommonJS package (no "type": "module")', () => {
    const pkg = JSON.parse(read('package.json')) as { type?: string };
    expect(pkg.type).toBeUndefined();
    // tiny-slug is installed through a file: dependency, so node_modules only holds a link to vendor/.
    expect(fs.realpathSync(path.join(MODULES, 'tiny-slug'))).toBe(fs.realpathSync(path.join(ROOT, 'vendor/tiny-slug')));
  });

  test('uploadName: node:path and a local package stay external; the test/ baseline is used', async () => {
    const { report, provider } = await run('src/upload.ts', 'uploadName');
    expect(report.failure).toBeUndefined();
    expect(report.status).toBe('completed');
    expect(report.stage).toBe('completed');

    // Package and built-in imports are recorded as not sent; their code is never part of the context.
    expect(report.contextExclusions).toEqual(['Node built-in import node:path (not sent)', 'package import tiny-slug (not sent)']);
    expect(report.contextFiles).toEqual(['src/upload.ts', 'test/upload.test.ts']);
    expect(Object.keys(report.inputHashes)).toEqual(['src/upload.ts', 'test/upload.test.ts', 'package.json', 'package-lock.json']);
    const prompt = provider.prompts[0];
    expect(prompt).toContain('whose code is not shown: "node:path", "tiny-slug".');
    expect(prompt).not.toContain('.split(/[^a-z0-9]+/)'); // vendor/tiny-slug/index.js
    expect(prompt).not.toContain('declare module'); // the @types/node stand-in
    // The skipped test and the .each template are not claimed as existing coverage.
    expect(prompt).not.toContain('Existing tests already cover');

    // test/upload.test.ts (describe, beforeEach, it.each, it.skip) is the baseline; test/legacy/upload.test.ts
    // has the same name but does not import the module, so it is ignored (it would be rejected for it.concurrent).
    expect(report.baselineTests).toEqual(['test/upload.test.ts']);
    expect(report.baselineRuns).toEqual(['completed', 'completed']);
    expect(report.candidateRuns).toEqual(['completed', 'completed']);
    expect(report.cases.map((c) => [c.title, c.status, c.originalOutcome])).toEqual([
      ['slug of exactly 12 characters is kept', 'accepted', 'passed'],
      ['slug of 13 characters is cut to 11 and "~"', 'accepted', 'passed'],
      ['name without letters or digits throws TypeError', 'accepted', 'passed'],
    ]);
    expect(report.mutations.map((m) => `${m.original}->${m.replacement}: ${m.baseline}/${m.generated}`)).toEqual([
      "slug === ''->false: survived/killed",
      "slug === ''->true: killed/killed",
      '===->!==: killed/killed',
      '>->>=: survived/killed',
      '12->11: survived/killed',
      '12->13: survived/killed',
      '+->-: invalid/invalid',
      '===->!==: killed/killed',
    ]);
    expect(report.scores.comparison).toEqual({ denominator: 7, before: 3, after: 7, excluded: 1 });
    // Generated tests are still written next to the module.
    expect(report.generatedTestPath).toBe(`src/upload.testforge.${report.runId}.test.ts`);
    expect(report.generatedTest).toContain('import { uploadName } from "./upload.js";');
    expect(report.inputHashes['src/upload.ts']).toBe(before['src/upload.ts']);
  });

  test('remainingQuota: the __tests__ baseline (vi, afterEach, .todo) is used; improvement cases verify despite the todo test', async () => {
    const { report } = await run('src/quota.ts', 'remainingQuota');
    expect(report.failure).toBeUndefined();
    expect(report.status).toBe('completed');
    expect(report.contextExclusions).toEqual([]);
    expect(report.contextFiles).toEqual(['src/quota.ts', 'src/__tests__/quota.test.ts']);
    expect(report.baselineTests).toEqual(['src/__tests__/quota.test.ts']);
    expect(report.baselineRuns).toEqual(['completed', 'completed']);
    // The vi.spyOn test detects that the warning is gone; the generated cases cannot see console output.
    const noWarn = report.mutations.find((m) => m.original === 'left < 0' && m.replacement === 'false')!;
    expect(noWarn).toMatchObject({ baseline: 'killed', generated: 'killed', detectingTests: ['remainingQuota warns and returns 0 when over the limit'] });
    // The first round misses the limit of exactly 0; the improvement case is verified against a suite with a todo test.
    const added = report.cases.filter((c) => c.round === 'improvement');
    expect(added.map((c) => [c.title, c.status, c.originalOutcome])).toEqual([['a limit of 0 is allowed', 'accepted', 'passed']]);
    expect(report.generatedTest).toContain(`[${added[0].id}] a limit of 0 is allowed`);
    expect(report.improvement).toEqual({ survivorsBefore: 4, proposed: 1, added: 1, killed: 1 });
    expect(report.mutations.find((m) => m.original === '<' && m.replacement === '<=' && m.line === 7)).toMatchObject({ baseline: 'survived', generated: 'killed' });
    expect(report.scores.comparison).toEqual({ denominator: 8, before: 3, after: 5, excluded: 0 });
  });

  test('a project with only pnpm-lock.yaml runs end to end (the lockfile is only hashed)', async () => {
    const root = quotaProject({ 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n", 'src/__tests__/quota.test.ts': read('src/__tests__/quota.test.ts') });
    const { report } = await run('src/quota.ts', 'remainingQuota', { root, mutationSample: 2, improve: false });
    expect(report.failure).toBeUndefined();
    expect(report.status).toBe('completed');
    expect(Object.keys(report.inputHashes)).toEqual(['src/quota.ts', 'src/__tests__/quota.test.ts', 'package.json', 'pnpm-lock.yaml']);
    expect(report.mutations.every((m) => m.generated === 'killed' || m.generated === 'survived')).toBe(true);
  });

  test('a failing hook or an unhandled error in a baseline test stops the run instead of counting as passing', async () => {
    const baseline = (body: string) => ({
      'package-lock.json': read('package-lock.json'),
      'src/__tests__/quota.test.ts': `import { afterAll, expect, it } from 'vitest';\nimport { remainingQuota } from '../quota.js';\n\n${body}\n`,
    });
    const hook = await run('src/quota.ts', 'remainingQuota', {
      root: quotaProject(baseline("afterAll(() => {\n  throw new Error('cleanup failed');\n});\n\nit('one byte left', () => {\n  expect(remainingQuota(99, 100)).toBe(1);\n});")),
    });
    // Every test passed, but Vitest failed the file.
    expect(hook.report.failure).toMatchObject({ kind: 'infrastructure', message: 'Existing tests could not be run (error).' });
    expect(hook.report.failure?.detail).toMatch(/^src\/__tests__\/quota\.test\.ts: .*cleanup failed/);
    const unhandled = await run('src/quota.ts', 'remainingQuota', {
      root: quotaProject(baseline("it('one byte left', () => {\n  void Promise.reject(new Error('not awaited'));\n  expect(remainingQuota(99, 100)).toBe(1);\n});")),
    });
    // Every test passed and the file passed, but Vitest exited with an error.
    expect(unhandled.report.failure).toMatchObject({ kind: 'infrastructure', detail: 'Vitest exited with code 1 although no test failed (for example an unhandled error)' });
    for (const r of [hook.report, unhandled.report]) {
      expect(r.status).toBe('failed');
      expect(r.baselineRuns).toEqual(['error']);
      expect(r.modelRequests).toBe(0);
    }
  });

  test('fixture files are byte-for-byte unchanged and nothing is written into node_modules', () => {
    expect(hashTree(ROOT)).toEqual(before);
    expect(fs.existsSync(path.join(MODULES, '.vite-temp'))).toBe(false);
    expect(fs.readdirSync(MODULES).sort()).toEqual(moduleEntries);
  });
});
