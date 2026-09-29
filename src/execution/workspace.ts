// Extension-owned temporary run directories: copies of approved files, a validated
// node_modules link, and extension-owned Vitest/TypeScript configs.
// NOTE: a temporary copy is NOT a security sandbox; code still runs as the user.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LIMITS, TestForgeError } from '../core/types';

export const SENTINEL = '.testforge-owned.json';
const PREFIX = 'testforge-run-';

export interface RunDir {
  root: string;
  tmp: string; // TMPDIR for child processes
}

export function createRunDir(runId: string, base = os.tmpdir()): RunDir {
  // realpath: Vitest reports real paths (macOS tmpdir is a symlink).
  const root = fs.realpathSync(fs.mkdtempSync(path.join(base, `${PREFIX}${runId}-`)));
  fs.writeFileSync(path.join(root, SENTINEL), JSON.stringify({ owner: 'testforge', runId, created: Date.now() }));
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp);
  return { root, tmp };
}

function isOwned(dir: string): boolean {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, SENTINEL), 'utf8')) as { owner?: string };
    return s.owner === 'testforge' && path.basename(dir).startsWith(PREFIX);
  } catch {
    return false;
  }
}

/** Deletes a run directory only if it carries our ownership sentinel. */
export function removeRunDir(dir: string): boolean {
  if (!isOwned(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return !fs.existsSync(dir);
}

/** Removes owned run directories older than maxAgeMs (after a crash or restart). */
export function cleanupStale(base = os.tmpdir(), maxAgeMs = 24 * 3600_000): number {
  let removed = 0;
  for (const name of fs.readdirSync(base)) {
    if (!name.startsWith(PREFIX)) continue;
    const dir = path.join(base, name);
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, SENTINEL), 'utf8')) as { created?: number };
      if (typeof s.created === 'number' && Date.now() - s.created > maxAgeMs && removeRunDir(dir)) removed++;
    } catch {
      // not ours or unreadable: leave it alone
    }
  }
  return removed;
}

function safeJoin(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) throw new TestForgeError('unsupported', `path ${rel} escapes the run directory`);
  return abs;
}

/**
 * Creates one execution copy: files at their relative paths, package.json, a
 * node_modules link to the target's installed dependencies, and our own configs.
 */
export function createCopy(run: RunDir, name: string, projectRoot: string, files: { rel: string; text: string }[], testFiles: string[]): string {
  const dir = safeJoin(run.root, name);
  fs.mkdirSync(dir);
  for (const f of files) {
    const abs = safeJoin(dir, f.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.text, { flag: 'wx' });
  }
  fs.copyFileSync(path.join(projectRoot, 'package.json'), path.join(dir, 'package.json'));
  try {
    fs.symlinkSync(path.join(projectRoot, 'node_modules'), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (e) {
    throw new TestForgeError('setup', 'Could not link the project node_modules into the execution copy. TestForge does not install dependencies as a fallback.', String(e));
  }
  writeConfigs(dir, files.map((f) => f.rel).filter((r) => !testFiles.includes(r)), testFiles);
  return dir;
}

/** (Re)writes the extension-owned configs for the given test file list. */
export function writeConfigs(dir: string, sources: string[], testFiles: string[]): void {
  const vitest = {
    test: {
      root: dir,
      include: testFiles,
      environment: 'node',
      watch: false,
      pool: 'forks',
      maxWorkers: 1,
      fileParallelism: false,
      sequence: { shuffle: false },
      testTimeout: LIMITS.testTimeoutMs,
      hookTimeout: LIMITS.testTimeoutMs,
      allowOnly: false,
      passWithNoTests: false,
      setupFiles: [],
      globalSetup: [],
    },
    root: dir,
    cacheDir: path.join(dir, '.vite-cache'),
  };
  fs.writeFileSync(path.join(dir, 'vitest.testforge.config.mjs'), `export default ${JSON.stringify(vitest, null, 2)};\n`);
  const tsconfig = {
    compilerOptions: { strict: true, noEmit: true, module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022', skipLibCheck: true, types: [] },
    files: [...sources, ...testFiles],
  };
  fs.writeFileSync(path.join(dir, 'tsconfig.testforge.json'), JSON.stringify(tsconfig, null, 2));
}

export function writeFile(copyDir: string, rel: string, text: string): void {
  fs.writeFileSync(safeJoin(copyDir, rel), text);
}
