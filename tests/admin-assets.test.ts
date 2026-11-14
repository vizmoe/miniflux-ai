import Fastify from 'fastify';
import * as fs from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { registerConsole } from '../src/admin/assets.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
afterEach(() => vi.clearAllMocks());

it('distinguishes a missing build from asset permission and I/O failures', async () => {
  const app = Fastify();
  const failures: unknown[] = [];
  app.setErrorHandler((error, _request, reply) => {
    failures.push(error);
    return reply.code(503).send({ code: 'service_unavailable' });
  });
  registerConsole(app);
  try {
    vi.mocked(fs.readFile).mockRejectedValueOnce(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );
    expect((await app.inject('/console/')).json()).toEqual({
      code: 'console_build_missing',
    });
    for (const code of ['EACCES', 'EIO']) {
      const error = Object.assign(new Error('fixture I/O failure'), { code });
      vi.mocked(fs.readFile).mockRejectedValueOnce(error);
      expect((await app.inject('/console/')).json()).toEqual({
        code: 'service_unavailable',
      });
      expect(failures.at(-1)).toBe(error);
    }
  } finally {
    await app.close();
  }
});
