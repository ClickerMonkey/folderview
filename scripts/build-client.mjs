// Bundles the page (client/) into dist/client: one small entry, with Shiki's grammars, Mermaid and the math renderer
// split into chunks the page loads only when a file needs them.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist', 'client');
const watch = process.argv.includes('--watch');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
fs.copyFileSync(path.join(root, 'client', 'index.html'), path.join(out, 'index.html'));

const options = {
  entryPoints: { main: path.join(root, 'client', 'src', 'main.js'), app: path.join(root, 'client', 'src', 'app.css') },
  outdir: path.join(out, 'assets'),
  bundle: true,
  splitting: true,
  format: 'esm',
  target: ['es2022', 'safari16'],
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  chunkNames: 'chunks/[name]-[hash]',
  legalComments: 'none',
  logLevel: 'warning',
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching client/ …');
} else {
  await esbuild.build(options);
  let bytes = 0,
    files = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        bytes += fs.statSync(p).size;
        files++;
      }
    }
  };
  walk(out);
  const main = fs.statSync(path.join(out, 'assets', 'main.js')).size;
  console.log(`client: ${files} files, ${(bytes / 1048576).toFixed(1)} MB (entry ${(main / 1024).toFixed(0)} KB)`);
}
