import { rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await rm(new URL('../dist/', import.meta.url), {
  recursive: true,
  force: true,
});
execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json'], {
  cwd: root,
  stdio: 'inherit',
});
await import('./build-admin.mjs');
