import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseHTML } from 'linkedom';
import { expect, it } from 'vitest';

it('changes asset URLs only when their built content changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mfai-admin-build-'));
  const run = promisify(execFile);
  const build = async () => {
    await run(process.execPath, [join(directory, 'scripts/build-admin.mjs')], {
      cwd: join(directory, 'working-directory'),
    });
    const { document } = parseHTML(
      await readFile(join(directory, 'dist/admin/index.html'), 'utf8'),
    );
    return {
      script: document.querySelector('script[src]')!.getAttribute('src')!,
      style: document
        .querySelector('link[rel="stylesheet"]')!
        .getAttribute('href')!,
    };
  };
  try {
    await mkdir(join(directory, 'scripts'));
    await mkdir(join(directory, 'working-directory'));
    await copyFile(
      new URL('../scripts/build-admin.mjs', import.meta.url),
      join(directory, 'scripts/build-admin.mjs'),
    );
    await symlink(
      fileURLToPath(new URL('../node_modules/', import.meta.url)),
      join(directory, 'node_modules'),
      'dir',
    );
    await mkdir(join(directory, 'admin'));
    await copyFile(
      new URL('../admin/index.html', import.meta.url),
      join(directory, 'admin/index.html'),
    );
    await writeFile(
      join(directory, 'admin/main.ts'),
      'import "./style.css"; document.title = "First release";',
    );
    await writeFile(
      join(directory, 'admin/style.css'),
      'body { color: black; }',
    );
    const first = await build();
    for (const asset of Object.values(first)) {
      const url = new URL(asset, 'http://localhost');
      expect(url.searchParams.get('v')).toBeTruthy();
      expect(['app.js', 'app.css']).toContain(url.pathname.split('/').at(-1));
    }
    expect(await build()).toEqual(first);

    await writeFile(
      join(directory, 'admin/main.ts'),
      'import "./style.css"; document.title = "Second release";',
    );
    const changedScript = await build();
    expect(changedScript.script).not.toBe(first.script);
    expect(changedScript.style).toBe(first.style);

    await writeFile(
      join(directory, 'admin/style.css'),
      'body { color: white; }',
    );
    const changedStyle = await build();
    expect(changedStyle.style).not.toBe(changedScript.style);
    expect(changedStyle.script).toBe(changedScript.script);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
