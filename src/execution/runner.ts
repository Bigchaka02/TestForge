// Spawns known executables (never a shell), bounds output, enforces deadlines and
// cancellation, and parses Vitest's JSON report.
import { spawn, execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LIMITS, SuiteRun, TestForgeError, TestResult } from '../core/types';
import toolchain from '../../toolchain.json';

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
}

const children = new Set<number>();

function killTree(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(pid), '/t', '/f'], () => undefined);
    } else {
      process.kill(-pid, signal); // negative pid = the whole process group
    }
  } catch {
    // already gone
  }
}

/** Terminates every process this extension spawned (used on deactivate). */
export function killAll(): void {
  for (const pid of children) killTree(pid, 'SIGKILL');
  children.clear();
}

/** Environment passed to child processes: only what Node needs, nothing injectable. */
export function childEnv(tmpDir: string): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, TMPDIR: tmpDir, TEMP: tmpDir, TMP: tmpDir, CI: '1', TZ: 'UTC', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NODE_ENV: 'test', FORCE_COLOR: '0', NO_COLOR: '1' };
}

export function runProcess(file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; deadlineMs: number; signal?: AbortSignal }): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let size = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      if (child.pid === undefined) return;
      killTree(child.pid, 'SIGTERM');
      forceTimer = setTimeout(() => child.pid !== undefined && killTree(child.pid, 'SIGKILL'), 2000);
    };
    const collect = (which: 'out' | 'err') => (chunk: Buffer) => {
      size += chunk.length;
      if (size > LIMITS.maxOutputBytes) {
        if (!truncated) {
          truncated = true;
          stop();
        }
        return;
      }
      if (which === 'out') stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));
    if (child.pid !== undefined) children.add(child.pid);
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.deadlineMs);
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (code: number | null) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (child.pid !== undefined) {
        // Reap any grandchildren left in the group.
        if (process.platform !== 'win32') killTree(child.pid, 'SIGKILL');
        children.delete(child.pid);
      }
      resolve({ code, stdout, stderr, timedOut, cancelled, truncated });
    };
    child.on('error', (err) => {
      stderr += String(err);
      finish(null);
    });
    child.on('close', finish);
  });
}

function versionAtLeast(v: string, min: string): boolean {
  const a = v.replace(/^v/, '').split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/** Finds a real Node binary: the configured path, else the first `node` on PATH. */
export async function resolveNode(configured: string | undefined, tmpDir: string): Promise<{ path: string; version: string }> {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  const candidates = configured ? [configured] : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, exe));
  const found = candidates.find((c) => {
    try {
      return fs.statSync(c).isFile();
    } catch {
      return false;
    }
  });
  if (!found) throw new TestForgeError('setup', configured ? `testforge.nodePath "${configured}" does not exist.` : 'No `node` executable was found on PATH. Install Node.js or set testforge.nodePath.');
  const r = await runProcess(found, ['--version'], { cwd: tmpDir, env: childEnv(tmpDir), deadlineMs: 10_000 });
  const version = r.stdout.trim();
  if (r.code !== 0 || !/^v\d+\.\d+\.\d+/.test(version)) throw new TestForgeError('setup', `${found} did not report a Node.js version.`);
  if (!versionAtLeast(version, toolchain.target.node.min)) throw new TestForgeError('setup', `Node ${version} is too old; ${toolchain.target.node.min} or newer is required by the supported Vitest version.`);
  return { path: found, version: version.slice(1) };
}

export interface Tools {
  node: string;
  tscCli: string; // absolute path to typescript/bin/tsc in the target project
  vitestCli: string; // absolute path to vitest's bin in the target project
}

/** Resolves CLI entry points from the target's installed package metadata. */
export function resolveTools(projectRoot: string, node: string): Tools {
  const bin = (pkg: string, name: string) => {
    const dir = path.join(projectRoot, 'node_modules', pkg);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> };
    const rel = typeof meta.bin === 'string' ? meta.bin : meta.bin?.[name];
    if (!rel) throw new TestForgeError('setup', `${pkg} does not declare a "${name}" executable.`);
    const abs = path.resolve(dir, rel);
    if (!abs.startsWith(dir + path.sep) || !fs.existsSync(abs)) throw new TestForgeError('setup', `${pkg}'s "${name}" executable is missing.`);
    return abs;
  };
  return { node, tscCli: bin('typescript', 'tsc'), vitestCli: bin('vitest', 'vitest') };
}

export async function typeCheck(tools: Tools, copyDir: string, tmp: string, signal?: AbortSignal): Promise<{ ok: boolean; output: string; cancelled: boolean; timedOut: boolean }> {
  const r = await runProcess(tools.node, [tools.tscCli, '-p', 'tsconfig.testforge.json'], { cwd: copyDir, env: childEnv(tmp), deadlineMs: LIMITS.processDeadlineMs, signal });
  return { ok: r.code === 0 && !r.timedOut && !r.cancelled, output: (r.stdout + r.stderr).slice(0, 4000), cancelled: r.cancelled, timedOut: r.timedOut };
}

interface VitestJson {
  numTotalTests: number;
  testResults: { name: string; status: string; message?: string; assertionResults: { title: string; fullName: string; status: string; failureMessages: string[]; ancestorTitles: string[] }[] }[];
}

const TIMEOUT_RE = /Test timed out in \d+ms|Hook timed out in \d+ms/;

/** Parses the pinned Vitest JSON report into per-test results. */
export function parseVitestReport(json: string, copyDir: string, expectedFiles: string[]): SuiteRun {
  let report: VitestJson;
  try {
    report = JSON.parse(json) as VitestJson;
  } catch {
    return { status: 'error', tests: [], error: 'Vitest report is not valid JSON' };
  }
  if (!Array.isArray(report.testResults)) return { status: 'error', tests: [], error: 'Vitest report has no testResults' };
  const tests: TestResult[] = [];
  const problems: string[] = [];
  for (const file of report.testResults) {
    const rel = path.relative(copyDir, file.name).split(path.sep).join('/');
    if (file.assertionResults.length === 0) problems.push(`${rel}: ${file.message || 'no tests were collected'}`);
    for (const a of file.assertionResults) {
      const msg = a.failureMessages.join('\n');
      const status = a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped';
      tests.push({ file: rel, title: a.fullName, status, timedOut: TIMEOUT_RE.test(msg), message: msg ? msg.slice(0, 2000) : undefined });
    }
  }
  const seen = new Set(tests.map((t) => t.file));
  for (const f of expectedFiles) if (!seen.has(f)) problems.push(`${f}: missing from the report`);
  if (tests.some((t) => t.status === 'skipped')) problems.push('some tests were skipped');
  if (problems.length) return { status: 'error', tests, error: problems.join('; ') };
  if (tests.some((t) => t.timedOut)) return { status: 'timeout', tests };
  return { status: 'completed', tests };
}

let reportCounter = 0;

export async function runVitest(tools: Tools, copyDir: string, tmp: string, testFiles: string[], signal?: AbortSignal): Promise<SuiteRun> {
  const reportPath = path.join(copyDir, `.testforge-report-${++reportCounter}.json`);
  const r = await runProcess(tools.node, [tools.vitestCli, 'run', '--config', 'vitest.testforge.config.mjs', '--reporter=json', `--outputFile=${reportPath}`], {
    cwd: copyDir,
    env: childEnv(tmp),
    deadlineMs: LIMITS.processDeadlineMs,
    signal,
  });
  if (r.cancelled) return { status: 'cancelled', tests: [] };
  if (r.timedOut) return { status: 'timeout', tests: [], error: `process exceeded ${LIMITS.processDeadlineMs / 1000}s` };
  if (r.truncated) return { status: 'error', tests: [], error: 'output exceeded 1 MiB' };
  if (!fs.existsSync(reportPath)) return { status: 'error', tests: [], error: `no report produced (exit ${r.code}): ${(r.stderr || r.stdout).slice(0, 1500)}` };
  const run = parseVitestReport(fs.readFileSync(reportPath, 'utf8'), copyDir, testFiles);
  fs.rmSync(reportPath, { force: true });
  if (run.tests.length === 0 && run.status === 'completed') return { status: 'error', tests: [], error: 'zero tests executed' };
  return run;
}
