/** Users (admin manages; anyone changes own password) + per-user client settings. */
import type { FastifyInstance } from 'fastify';
import { q, one, run, insertId } from '../db.ts';
import { hashPassword, verifyPassword } from '../crypto.ts';
import { syncManager } from '../imap/sync.ts';
import { uid, isAdmin } from './util.ts';

export function register(app: FastifyInstance): void {
  // ---- users (admin manages; anyone can change own password) ----
  app.get('/api/users', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    return q('SELECT id, email, name, role, created_at FROM users ORDER BY id');
  });

  app.post('/api/users', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    const b = req.body as { email: string; name?: string; password: string; role?: string };
    if (!b.email || !/^[^@\s]+@[^@\s]+$/.test(b.email)) return reply.code(400).send({ error: 'valid email required' });
    if (!b.password || b.password.length < 8) return reply.code(400).send({ error: 'password must be at least 8 characters' });
    if (await one('SELECT 1 FROM users WHERE email = ?', [b.email.toLowerCase()])) {
      return reply.code(400).send({ error: 'email already exists' });
    }
    const id = await insertId('INSERT INTO users(email, name, password_hash, role, created_at) VALUES (?,?,?,?,?)',
      [b.email.toLowerCase(), b.name ?? '', hashPassword(b.password), b.role === 'admin' ? 'admin' : 'member', Date.now()]);
    return { id };
  });

  app.delete('/api/users/:id', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    const id = Number((req.params as any).id);
    if (id === uid(req)) return reply.code(400).send({ error: 'cannot delete yourself' });
    const accounts = await q<{ id: number }>('SELECT id FROM accounts WHERE user_id = ?', [id]);
    for (const a of accounts) syncManager.stopAccount(a.id);
    await run('DELETE FROM users WHERE id = ?', [id]);
    return { ok: true };
  });

  app.put('/api/users/password', async (req, reply) => {
    const { current, password } = req.body as { current: string; password: string };
    if (!password || password.length < 8) return reply.code(400).send({ error: 'password must be at least 8 characters' });
    const user = await one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [uid(req)]);
    if (!user || !verifyPassword(current ?? '', user.password_hash)) return reply.code(401).send({ error: 'wrong current password' });
    await run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(password), uid(req)]);
    return { ok: true };
  });

  // ---- client settings (per user) ----
  app.put('/api/settings', async (req) => {
    await run('UPDATE users SET settings_json = ? WHERE id = ?', [JSON.stringify(req.body ?? {}), uid(req)]);
    return { ok: true };
  });
}
