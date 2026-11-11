/** Public tracking pixel. */
import type { FastifyInstance } from 'fastify';
import { recordOpen } from '../mail/tracking.ts';

const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

export function register(app: FastifyInstance): void {
  // ---- tracking pixel (public) ----
  app.get('/t/:file', async (req, reply) => {
    const m = String((req.params as any).file).match(/^([a-f0-9]{32})\.gif$/);
    if (m) await recordOpen(m[1], req.ip, String(req.headers['user-agent'] ?? ''));
    reply.header('Content-Type', 'image/gif');
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    // loaded cross-origin by every mail client: never restrict who may embed it
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    return reply.send(PIXEL_GIF);
  });
}
