import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
mkdirSync('dist', { recursive: true });

// Static assets copied verbatim (served from 'self' under strict CSP).
for (const f of ['index.html', 'app.css']) cpSync(`src/${f}`, `dist/${f}`);

const opts = {
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  minify: !watch,
  sourcemap: watch,
  outfile: 'dist/app.js',
  legalComments: 'none',
};

if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  console.log('watching…');
} else {
  await esbuild.build(opts);
  console.log('built dist/app.js');
}
