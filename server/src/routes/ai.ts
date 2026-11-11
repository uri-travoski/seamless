/** AI providers, task mapping, summarize/draft. */
import type { FastifyInstance } from 'fastify';
import { q, one, run, insertId } from '../db.ts';
import { encrypt } from '../crypto.ts';
import { summarizeThread, draftReply } from '../ai/tasks.ts';
import { chatComplete, getProvider } from '../ai/client.ts';
import { uid } from './util.ts';

export function register(app: FastifyInstance): void {
  // ---- AI ----
  app.get('/api/ai/providers', async (req) =>
    (await q<any>('SELECT id, name, base_url, model, api_key_enc FROM ai_providers WHERE user_id = ? ORDER BY id', [uid(req)]))
      .map((r) => ({ id: r.id, name: r.name, baseUrl: r.base_url, model: r.model, hasKey: !!r.api_key_enc })));

  app.post('/api/ai/providers', async (req) => {
    const b = req.body as any;
    const id = await insertId('INSERT INTO ai_providers(user_id, name, base_url, api_key_enc, model) VALUES (?,?,?,?,?)',
      [uid(req), b.name, b.baseUrl.replace(/\/$/, ''), b.apiKey ? encrypt(b.apiKey) : '', b.model ?? '']);
    return { id };
  });

  app.put('/api/ai/providers/:id', async (req) => {
    const b = req.body as any;
    const id = Number((req.params as any).id);
    const existing = await one<any>('SELECT api_key_enc FROM ai_providers WHERE id = ? AND user_id = ?', [id, uid(req)]);
    await run('UPDATE ai_providers SET name=?, base_url=?, api_key_enc=?, model=? WHERE id=? AND user_id=?',
      [b.name, b.baseUrl.replace(/\/$/, ''), b.apiKey ? encrypt(b.apiKey) : existing?.api_key_enc ?? '', b.model ?? '', id, uid(req)]);
    return { ok: true };
  });

  app.delete('/api/ai/providers/:id', async (req) => {
    await run('DELETE FROM ai_providers WHERE id = ? AND user_id = ?', [Number((req.params as any).id), uid(req)]);
    return { ok: true };
  });

  app.get('/api/ai/tasks', async (req) => q('SELECT task, provider_id, model, enabled FROM ai_tasks WHERE user_id = ?', [uid(req)]));

  app.put('/api/ai/tasks', async (req) => {
    const tasks = req.body as { task: string; providerId: number | null; model: string; enabled: boolean }[];
    for (const t of tasks) {
      await run(`
        INSERT INTO ai_tasks(user_id, task, provider_id, model, enabled) VALUES (?,?,?,?,?)
        ON CONFLICT(user_id, task) DO UPDATE SET provider_id=excluded.provider_id, model=excluded.model, enabled=excluded.enabled
      `, [uid(req), t.task, t.providerId, t.model ?? '', !!t.enabled]);
    }
    return { ok: true };
  });

  app.post('/api/ai/test/:id', async (req, reply) => {
    const provider = await getProvider(uid(req), Number((req.params as any).id));
    if (!provider) return reply.code(404).send({ error: 'not found' });
    try {
      const out = await chatComplete(provider, [{ role: 'user', content: 'Reply with the single word: ok' }], { maxTokens: 10 });
      return { ok: true, reply: out.trim().slice(0, 100) };
    } catch (err: any) {
      return reply.code(502).send({ ok: false, error: err?.message });
    }
  });

  app.post('/api/ai/summarize', async (req, reply) => {
    try { return { summary: await summarizeThread(uid(req), (req.body as any).threadId) }; }
    catch (err: any) { return reply.code(400).send({ error: err?.message }); }
  });

  app.post('/api/ai/draft', async (req, reply) => {
    try { return { draft: await draftReply(uid(req), (req.body as any).emailId, (req.body as any).instruction ?? '') }; }
    catch (err: any) { return reply.code(400).send({ error: err?.message }); }
  });
}
