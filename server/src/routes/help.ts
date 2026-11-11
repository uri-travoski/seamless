/** In-app manual + getting-started wizard status. */
import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { one } from '../db.ts';
import { uid } from './util.ts';

export function register(app: FastifyInstance): void {
  // ---- in-app manual ----
  app.get('/api/help', async () => {
    const dir = path.resolve(fileURLToPath(import.meta.url), '../../../../docs/manual');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => ({
      id: f.replace(/\.md$/, ''),
      title: (fs.readFileSync(path.join(dir, f), 'utf8').match(/^#\s+(.+)$/m)?.[1] ?? f).trim(),
    }));
  });

  app.get('/api/help/:page', async (req, reply) => {
    const page = String((req.params as any).page).replace(/[^a-z0-9-]/gi, '');
    const file = path.resolve(fileURLToPath(import.meta.url), '../../../../docs/manual', `${page}.md`);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'not found' });
    reply.type('text/markdown; charset=utf-8');
    return reply.send(fs.readFileSync(file, 'utf8'));
  });

  // ---- getting-started wizard status ----
  app.get('/api/wizard/status', async (req) => {
    const userId = uid(req);
    const accounts = (await one<{ c: number }>('SELECT COUNT(*) c FROM accounts WHERE user_id = ?', [userId]))?.c ?? 0;
    const rules = (await one<{ c: number }>('SELECT COUNT(*) c FROM rules WHERE user_id = ?', [userId]))?.c ?? 0;
    const aiReady = !!(await one("SELECT 1 FROM ai_tasks WHERE user_id = ? AND task = 'classify' AND enabled = true AND provider_id IS NOT NULL", [userId]));
    const devices = (await one<{ c: number }>('SELECT COUNT(*) c FROM app_passwords WHERE user_id = ?', [userId]))?.c ?? 0;
    return { accounts, rules, aiReady, devices };
  });
}
