// Bundles the extension into dist/extension.js.
// Runtime dependencies (typescript, zod, toolchain.json) are bundled because
// the VSIX is packaged with `vsce package --no-dependencies`.
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const entry = process.env.TESTFORGE_ENTRY ?? 'src/extension.ts';
const outfile = process.env.TESTFORGE_OUTFILE ?? 'dist/extension.js';

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
  // typescript's CJS bundle references these optional modules behind guards.
  loader: { '.json': 'json' },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[esbuild] watching for changes...');
} else {
  await esbuild.build(options);
}
