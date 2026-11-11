/* In-process Fastify app for HTTP-level tests (fastify.inject, no network). */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { registerRoutes } from '../src/routes/index.ts';
import { registerSecurityHeaders } from '../src/security/headers.ts';
import { authLimiter, pixelLimiter, pixelDedupe, ingestFailLimiter, ingestLimiter } from '../src/security/ratelimit.ts';

export async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await registerSecurityHeaders(app);
  registerRoutes(app);
  await app.ready();
  return app;
}

export function resetLimiters(): void {
  authLimiter.clear(); pixelLimiter.clear(); pixelDedupe.clear(); ingestFailLimiter.clear(); ingestLimiter.clear();
}

/** Log in through the API and return the session cookie header value. */
export async function login(app: FastifyInstance, email = 'test@local', password = 'password123'): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode} ${res.body}`);
  const c = res.cookies.find((x) => x.name === 'smsession');
  if (!c) throw new Error('no session cookie');
  return `smsession=${c.value}`;
}
