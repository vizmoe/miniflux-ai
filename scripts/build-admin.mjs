import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(new URL('../dist/admin/', import.meta.url), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['web/app.ts'],
  outfile: 'dist/admin/app.js',
  bundle: true,
  format: 'esm',
  target: 'es2023',
  minify: true,
  sourcemap: true,
  sourcesContent: true,
});
for (const file of ['app.css', 'index.html'])
  await copyFile(
    new URL('../web/' + file, import.meta.url),
    new URL('../dist/admin/' + file, import.meta.url),
  );
