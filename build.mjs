import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: ['obsidian'],
  sourcemap: false,
  minify: false,
  legalComments: 'eof',
});
await copyFile('manifest.json', 'dist/manifest.json');
await copyFile('styles.css', 'dist/styles.css');
