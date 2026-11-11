/** Small per-user server-side switches (stored in user_settings): undo-send delay, snooze wake-on-reply. */
import type { FastifyInstance } from 'fastify';
import { getUserSetting, setUserSetting } from '../classify/settings.ts';
import { UNDO_CHOICES } from '../mail/undoSend.ts';
import { uid } from './util.ts';

export function register(app: FastifyInstance): void {
  app.get('/api/settings/server', async (req) => ({
    undoSendSeconds: Number(await getUserSetting(uid(req), 'undo_send_seconds') || '10'),
    snoozeWakeOnReply: (await getUserSetting(uid(req), 'snooze_wake_on_reply')) !== 'false',
  }));

  app.put('/api/settings/server', async (req, reply) => {
    const b = (req.body ?? {}) as { undoSendSeconds?: number; snoozeWakeOnReply?: boolean };
    if (b.undoSendSeconds !== undefined) {
      if (!UNDO_CHOICES.includes(String(b.undoSendSeconds))) return reply.code(400).send({ error: 'invalid undo delay' });
      await setUserSetting(uid(req), 'undo_send_seconds', String(b.undoSendSeconds));
    }
    if (b.snoozeWakeOnReply !== undefined) await setUserSetting(uid(req), 'snooze_wake_on_reply', b.snoozeWakeOnReply ? 'true' : 'false');
    return { ok: true };
  });
}
