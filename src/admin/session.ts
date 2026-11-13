import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Service } from '../runtime/service.js';
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../obs/errors.js';
const lifetime = 12 * 60 * 60 * 1000;
const cookieName = 'mfai_admin';
export class AdminSessions {
  service;
  failures = new Map<string, { count: number; until: number }>();
  constructor(service: Service) {
    this.service = service;
  }
  token(request: FastifyRequest) {
    return (
      (request.headers.cookie ?? '')
        .split(';')
        .map((v) => v.trim())
        .find((v) => v.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1) ?? ''
    );
  }
  hash(token: string) {
    return createHmac('sha256', this.service.config.server.admin_token!)
      .update(token)
      .digest('hex');
  }
  origin(request: FastifyRequest) {
    return new URL(
      this.service.config.server.admin_origin ??
        `${request.protocol}://${request.headers.host}`,
    ).origin;
  }
  sameOrigin(request: FastifyRequest) {
    let valid = false;
    try {
      valid =
        new URL(request.headers.origin ?? '').origin === this.origin(request);
    } catch {
      /* no origin */
    }
    if (!valid || request.headers['sec-fetch-site'] === 'cross-site')
      throw new ApiError(403, 'origin_rejected');
  }
  cookie(request: FastifyRequest, token: string, age: number) {
    return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${this.origin(request).startsWith('https:') ? '; Secure' : ''}`;
  }
  validSecret(value: string) {
    const digest = (s: string) => createHash('sha256').update(s).digest();
    return timingSafeEqual(
      digest(value),
      digest(this.service.config.server.admin_token!),
    );
  }
  authorize(request: FastifyRequest) {
    const bearer = request.headers.authorization;
    if (bearer) {
      if (!bearer.startsWith('Bearer ') || !this.validSecret(bearer.slice(7)))
        throw new ApiError(401, 'unauthorized');
      return;
    }
    const token = this.token(request);
    const session =
      /^[\da-f]{64}$/.test(token) &&
      this.service.db.get<{ expires_at: number }>(
        'SELECT expires_at FROM admin_sessions WHERE token_hash=?',
        this.hash(token),
      );
    if (!session || session.expires_at <= Date.now())
      throw new ApiError(401, 'unauthorized');
    if (!['GET', 'HEAD'].includes(request.method)) this.sameOrigin(request);
    if (request.headers['sec-fetch-site'] === 'cross-site')
      throw new ApiError(403, 'origin_rejected');
  }
  register(app: FastifyInstance) {
    app.post('/auth/session', { bodyLimit: 8192 }, async (request, reply) => {
      this.sameOrigin(request);
      const now = Date.now();
      for (const [ip, value] of this.failures)
        if (value.until <= now) this.failures.delete(ip);
      const attempt = this.failures.get(request.ip);
      if ((attempt?.count ?? 0) >= 10) {
        reply.header('Retry-After', '900');
        throw new ApiError(429, 'login_rate_limited');
      }
      let body;
      try {
        body = JSON.parse((request.body as Buffer).toString('utf8'));
      } catch {
        throw new ApiError(400, 'invalid_json');
      }
      const { token } = z
        .object({ token: z.string().min(1).max(4096) })
        .strict()
        .parse(body);
      if (!this.validSecret(token)) {
        if (!attempt && this.failures.size >= 1024)
          this.failures.delete(this.failures.keys().next().value!);
        this.failures.set(request.ip, {
          count: (attempt?.count ?? 0) + 1,
          until: attempt?.until ?? now + 900000,
        });
        throw new ApiError(401, 'unauthorized');
      }
      this.failures.delete(request.ip);
      const session = randomBytes(32).toString('hex');
      this.service.db.transaction(() => {
        this.service.db.run(
          'DELETE FROM admin_sessions WHERE expires_at<=? OR token_hash=?',
          now,
          this.hash(this.token(request)),
        );
        // A bounded set of devices prevents unbounded durable session accumulation.
        this.service.db.run(
          'DELETE FROM admin_sessions WHERE token_hash IN (SELECT token_hash FROM admin_sessions ORDER BY expires_at DESC LIMIT -1 OFFSET 31)',
        );
        this.service.db.run(
          'INSERT INTO admin_sessions(token_hash,expires_at) VALUES(?,?)',
          this.hash(session),
          now + lifetime,
        );
      });
      return reply
        .header('Cache-Control', 'no-store')
        .header('Set-Cookie', this.cookie(request, session, lifetime / 1000))
        .code(201)
        .send({ authenticated: true });
    });
    app.delete('/auth/session', async (request, reply) => {
      this.sameOrigin(request);
      this.service.db.run(
        'DELETE FROM admin_sessions WHERE token_hash=?',
        this.hash(this.token(request)),
      );
      return reply
        .header('Cache-Control', 'no-store')
        .header('Set-Cookie', this.cookie(request, '', 0))
        .code(204)
        .send();
    });
  }
}
