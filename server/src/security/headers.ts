/**
 * Security headers (T0 F-01): CSP, frame/referrer/permissions policies, HSTS on HTTPS.
 *
 * Notes on the choices:
 * - Mail bodies render in sandboxed `srcdoc` iframes, which inherit this CSP; their inline
 *   styles need 'unsafe-inline' for style-src (scripts stay blocked).
 * - Google Fonts are loaded at runtime for the font picker.
 * - COOP is `same-origin-allow-popups` so the OAuth popup can still postMessage back.
 * - Frames are SAMEORIGIN (not DENY) so same-origin previews keep working.
 */
import type { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import { httpsInstance } from '../auth/sessions.ts';

export function cspDirectives(https = httpsInstance): Record<string, string[]> {
  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
    imgSrc: ["'self'", 'data:', 'blob:', 'https:', ...(https ? [] : ['http:'])],
    connectSrc: ["'self'", 'ws:', 'wss:'],
    frameSrc: ["'self'", 'blob:'],
    workerSrc: ["'self'"],
    manifestSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'self'"],
  };
}

export async function registerSecurityHeaders(app: FastifyInstance): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: { useDefaults: false, directives: { ...cspDirectives(), ...(httpsInstance ? { upgradeInsecureRequests: [] } : {}) } },
    crossOriginEmbedderPolicy: false,
    // browsers ignore (and log an error for) COOP / origin-keying on plain-http origins such as a LAN IP
    crossOriginOpenerPolicy: httpsInstance ? { policy: 'same-origin-allow-popups' } : false,
    originAgentCluster: httpsInstance,
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    xFrameOptions: { action: 'sameorigin' },
    strictTransportSecurity: httpsInstance ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  });
}
