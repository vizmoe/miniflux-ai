import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { config, writeConfiguration } from './helpers.js';

it.each(['::1', '::'])(
  'healthchecks an IPv6-only listener bound to %s',
  async (bind_address) => {
    const root = mkdtempSync(join(tmpdir(), 'mfai-health-'));
    let requests = 0;
    const server = createServer((request, response) => {
      if (request.url === '/healthz') {
        requests++;
        response.end('ok');
      } else {
        response.statusCode = 404;
        response.end();
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: bind_address, port: 0, ipv6Only: true }, resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('listener_address_missing');
      const cfg = config();
      cfg.server.bind_address = bind_address;
      cfg.server.port = address.port;
      const store = writeConfiguration(root, cfg);
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', 'src/healthcheck.ts', '--config', store.path],
          {
            stdio: 'ignore',
            env: {
              ...process.env,
              AI_MODEL: 'environment-cannot-override-yaml',
              MFAI_HTTP_PORT: '1',
            },
          },
        );
        child.once('error', reject);
        child.once('exit', resolve);
      });
      expect(exitCode).toBe(0);
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  },
);
