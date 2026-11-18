import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

await mkdir('dist', { recursive: true });
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid release version');
const checksums = [];
for (const platform of ['macos', 'android']) {
  const directory = `dist/${platform}`;
  await mkdir(directory, { recursive: true });
  const result = await build({
    entryPoints: [platform === 'macos' ? 'src/main.ts' : 'src/mobile-main.ts'],
    outfile: `${directory}/main.js`, bundle: true, format: 'cjs',
    platform: platform === 'macos' ? 'node' : 'browser',
    target: platform === 'macos' ? 'node18' : 'chrome100',
    external: ['obsidian'], sourcemap: false, minify: false, legalComments: 'eof', metafile: true,
  });
  if (platform === 'android' && Object.values(result.metafile.outputs).some(output => output.imports.some(imported => imported.path !== 'obsidian'))) throw new Error('Android build contains a native or external module');
  await writeFile(`${directory}/manifest.json`, JSON.stringify({ ...manifest, isDesktopOnly: platform === 'macos' }, null, 2)+'\n');
  await copyFile('styles.css', `${directory}/styles.css`);
  await copyFile('LICENSE', `${directory}/LICENSE`);
  const archive = `wudao-git-${manifest.version}-${platform}.zip`;
  await rm(`dist/${archive}`, { force: true });
  execFileSync('zip', ['-q', '-j', resolve('dist', archive), 'main.js', 'manifest.json', 'styles.css', 'LICENSE'], { cwd: directory });
  checksums.push(`${createHash('sha256').update(await readFile(`dist/${archive}`)).digest('hex')}  ${archive}`);
}
await writeFile('dist/SHA256SUMS.txt', checksums.join('\n')+'\n');
// Keep the original desktop artifact paths available for existing local installs.
for (const name of ['main.js', 'manifest.json', 'styles.css']) await copyFile(`dist/macos/${name}`, `dist/${name}`);
