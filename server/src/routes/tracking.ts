/** Public tracking pixel. */
import type { FastifyInstance } from 'fastify';
import { run, bumpState } from '../db.ts';
import { broadcast } from '../ws.ts';

const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

export function register(app: FastifyInstance): void {
  // ---- tracking pixel (public) ----
  app.get('/t/:file', async (req, reply) => {
    const m = String((req.params as any).file).match(/^([a-f0-9]{32})\.gif$/);
    if (m) {
      await run('INSERT INTO tracking_opens(token, ts, ip, ua) VALUES (?,?,?,?)',
        [m[1], Date.now(), req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300)]);
      await bumpState();
      broadcast({ type: 'stateChange' });
    }
    reply.header('Content-Type', 'image/gif');
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    return reply.send(PIXEL_GIF);
  });
}
