import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../dist/admin/', import.meta.url);
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['admin/main.ts'],
  outfile: 'dist/admin/app.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2023',
  minify: true,
  sourcemap: true,
  sourcesContent: true,
});
let html = await readFile(
  new URL('../admin/index.html', import.meta.url),
  'utf8',
);
for (const file of ['app.js', 'app.css']) {
  const version = createHash('sha256')
    .update(await readFile(new URL(file, output)))
    .digest('hex');
  html = html.replaceAll(`/console/${file}`, `/console/${file}?v=${version}`);
}
await writeFile(new URL('index.html', output), html);
