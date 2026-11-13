/** Labels nest one level only, and a parent can't be deleted while it still has sub-labels. */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser } from './helpers.ts';

const { makeApp, login, resetLimiters } = await import('./app.ts');
let app: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;
const api = (method: any, url: string, body?: any) => app.inject({ method, url, payload: body, headers: { cookie } });
const mk = async (name: string, parentId?: number) => (await api('POST', '/api/labels', { name, parentId })).json().id as number;
const labels = async () => (await api('GET', '/api/labels')).json() as any[];

beforeEach(async () => {
  await resetDb(); resetLimiters();
  await makeUser('a@x.test');
  app = await makeApp();
  cookie = await login(app, 'a@x.test');
});

describe('one level of nesting', () => {
  it('lets a top-level label go inside another top-level label', async () => {
    const p = await mk('Clients'); const c = await mk('Acme');
    expect((await api('PUT', `/api/labels/${c}`, { parentId: p })).statusCode).toBe(200);
    expect((await labels()).find((l) => l.id === c).parentId).toBe(p);
  });
  it('refuses a third level (parent is already nested)', async () => {
    const p = await mk('Clients'); const c = await mk('Acme', p); const g = await mk('Quotes');
    const r = await api('PUT', `/api/labels/${g}`, { parentId: c });
    expect(r.statusCode).toBe(400); expect(r.json().error).toMatch(/one level/);
    expect((await api('POST', '/api/labels', { name: 'Deep', parentId: c })).statusCode).toBe(400);
  });
  it('refuses to nest a label that has sub-labels', async () => {
    const p = await mk('Clients'); await mk('Acme', p); const other = await mk('Other');
    const r = await api('PUT', `/api/labels/${p}`, { parentId: other });
    expect(r.statusCode).toBe(400); expect(r.json().error).toMatch(/sub-labels/);
  });
  it('can move a child back to top level', async () => {
    const p = await mk('Clients'); const c = await mk('Acme', p);
    expect((await api('PUT', `/api/labels/${c}`, { parentId: null })).statusCode).toBe(200);
    expect((await labels()).find((l) => l.id === c).parentId).toBeNull();
  });
  it('merge: a parent cannot be merged into a nested label', async () => {
    const p = await mk('Clients'); await mk('Acme', p); const other = await mk('Other'); const nested = await mk('Nested', other);
    const r = await api('POST', '/api/labels/merge', { sourceId: p, targetId: nested });
    expect(r.statusCode).toBe(400);
  });
});

describe('deleting a parent', () => {
  it('is refused while sub-labels remain (single and bulk)', async () => {
    const p = await mk('Clients'); const c = await mk('Acme', p);
    const one = await api('DELETE', `/api/labels/${p}`);
    expect(one.statusCode).toBe(409); expect(one.json().error).toMatch(/sub-labels/);
    const bulk = await api('POST', '/api/labels/delete', { ids: [p] });
    expect(bulk.statusCode).toBe(409);
    expect((await labels()).map((l) => l.id)).toEqual(expect.arrayContaining([p, c]));
  });
  it('works once the sub-labels are gone, or when they are deleted in the same request', async () => {
    const p = await mk('Clients'); const c = await mk('Acme', p);
    expect((await api('DELETE', `/api/labels/${c}`)).statusCode).toBe(200);
    expect((await api('DELETE', `/api/labels/${p}`)).statusCode).toBe(200);
    const p2 = await mk('Two'); const c2 = await mk('Child', p2);
    const r = await api('POST', '/api/labels/delete', { ids: [p2, c2] });
    expect(r.statusCode).toBe(200); expect(r.json().deleted).toBe(2);
  });
});
