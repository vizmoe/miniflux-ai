import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';

/** Fixed routes only: no user-controlled filesystem path or SPA catch-all. */
export function registerConsole(app: FastifyInstance): void {
  app.get('/console', async (_request, reply) => reply.redirect('/console/'));
  for (const [route, file, type] of [
    ['/console/', 'index.html', 'text/html; charset=utf-8'],
    ['/console/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/console/app.css', 'app.css', 'text/css; charset=utf-8'],
  ])
    app.get(route!, async (_request, reply) => {
      reply
        .header('Cache-Control', 'no-cache')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Referrer-Policy', 'no-referrer')
        .header(
          'Content-Security-Policy',
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        );
      try {
        const bytes = await readFile(
          new URL(`../../dist/admin/${file}`, import.meta.url),
        );
        return reply.type(type!).send(bytes);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 'ENOENT'
        )
          throw error;
        return reply.code(503).send({ code: 'console_build_missing' });
      }
    });
}
