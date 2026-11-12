/** T7.1: every manual page is served by the help route, none is empty, and relative links resolve. */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetDb, makeUser } from './helpers.ts';

const { makeApp, login, resetLimiters } = await import('./app.ts');
const dir = path.resolve(fileURLToPath(import.meta.url), '../../../docs/manual');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
let app: Awaited<ReturnType<typeof makeApp>>;
let ck = '';

beforeAll(async () => {
  await resetDb(); resetLimiters();
  await makeUser('manual@x.test');
  app = await makeApp();
  ck = await login(app, 'manual@x.test', 'password123');
});

describe('manual pages', () => {
  it('the help route lists every file, index first', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/help', headers: { cookie: ck } });
    expect(res.statusCode).toBe(200);
    const pages = res.json() as { id: string; title: string }[];
    expect(pages.map((p) => p.id)).toEqual(files.map((f) => f.replace(/\.md$/, '')));
    expect(pages[0].id).toBe('00-index');
    for (const p of pages) expect(p.title.length).toBeGreaterThan(0);
  });

  it('every page is served and has real content', async () => {
    for (const f of files) {
      const res = await app.inject({ method: 'GET', url: `/api/help/${f.replace(/\.md$/, '')}`, headers: { cookie: ck } });
      expect(res.statusCode, f).toBe(200);
      expect(res.body.trim().length, f).toBeGreaterThan(200);
      expect(res.body, f).toMatch(/^#\s+\S/m);
    }
  });

  it('relative links point at pages that exist', () => {
    const bad: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of text.matchAll(/\]\((?!https?:|mailto:|#|\/)([^)\s]+)\)/g)) {
        const target = m[1].split('#')[0];
        if (target && !fs.existsSync(path.join(dir, target))) bad.push(`${f} -> ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the index links to every other page', () => {
    const index = fs.readFileSync(path.join(dir, '00-index.md'), 'utf8');
    const missing = files.filter((f) => f !== '00-index.md' && !index.includes(`(${f})`));
    expect(missing).toEqual([]);
  });
});
