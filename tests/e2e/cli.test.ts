import { expect, it, vi } from 'vitest';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

it('runs the compiled CLI, passes its healthcheck, and shuts down cleanly', async () => {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  if (!address || typeof address === 'string')
    throw new Error('No free test port');
  const { port } = address;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const root = await mkdtemp(join(tmpdir(), 'miniflux-ai-cli-'));
  const path = join(root, 'config.yaml');
  const adminToken = 'cli-test-administrator';
  await writeFile(
    path,
    stringify({
      miniflux: {
        base_url: 'http://127.0.0.1:9',
        api_key: 'local-cli-test',
        request_timeout_ms: 100,
      },
      server: { port, bind_address: '127.0.0.1', admin_token: adminToken },
      ingestion: { webhook: { enabled: false } },
      runtime: { allow_insecure_http: true, shutdown_grace_period: '1s' },
    }),
  );
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../../dist/main.js', import.meta.url)),
      '--config',
      path,
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output: string[] = [];
  child.stdout.on('data', (data: Buffer) => output.push(data.toString()));
  child.stderr.on('data', (data: Buffer) => output.push(data.toString()));
  const exited = once(child, 'exit');
  try {
    await vi.waitFor(
      async () =>
        expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(
          200,
        ),
      { timeout: 10_000 },
    );
    expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(503);
    await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL('../../dist/healthcheck.js', import.meta.url)),
        '--config',
        path,
      ],
      { cwd: root, timeout: 5000 },
    );
    child.kill('SIGTERM');
    expect((await exited)[0]).toBe(0);
    const events = output.join('');
    expect(events).toContain('service_started');
    expect(events).toContain('service_stopped');
    expect(events).not.toContain(adminToken);
    const map = JSON.parse(
      await readFile(
        new URL('../../dist/main.js.map', import.meta.url),
        'utf8',
      ),
    ) as { sourcesContent: string[] };
    expect(map.sourcesContent[0]).toContain('async function main()');
    expect(
      (await readFile(join(root, 'data/miniflux-ai.db')))
        .subarray(0, 15)
        .toString(),
    ).toBe('SQLite format 3');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
