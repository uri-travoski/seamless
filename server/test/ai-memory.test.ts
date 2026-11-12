/** T8.10: why?, Fix it, undo, hand corrections, health, AI memory in backups and archives, Viewing mode. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest, rawEmail, blobStore, TEST_USER } from './helpers.ts';

const { q, one, run, insertId, migrate } = await import('../src/db.ts');
const { processPending } = await import('../src/classify/engine.ts');
const { setLabels, moveEmail } = await import('../src/mail/store.ts');
const { aiHealth, relearnBatch, noteEmbedDim, noteAiError } = await import('../src/classify/memory.ts');
const { runAlertChecks } = await import('../src/alerts/engine.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');
const { setStoredMode } = await import('../src/mode.ts');
const { createBackup, restoreBackup } = await import('../src/backup/engine.ts');
const { writeAiMemory, importAiSettings, importAiMessages } = await import('../src/archive/aimemory.ts');

let DIM = 64;
function fakeEmbedding(text: string, dim = DIM): number[] {
  const vec = new Array(dim).fill(0);
  for (const w of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    const h = crypto.createHash('md5').update(w).digest();
    for (let i = 0; i < 8; i++) vec[h[i] % dim] += (h[(i + 8) % 16] / 128) - 1;
  }
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map((x) => x / norm);
}

let fetchCalls = 0; let llmFails = false;
let A: number, B: number, acct: number, inbox: number, trash: number, sale: number, receipts: number;
let app: Awaited<ReturnType<typeof makeApp>>; let cka = '', ckb = '';
const api = (ck: string, method: any, url: string, body?: any) => app.inject({ method, url, payload: body, headers: { cookie: ck } });

beforeEach(async () => {
  await migrate();
  await resetDb(); resetLimiters(); blobStore.clear(); fetchCalls = 0; llmFails = false; DIM = 64;
  A = TEST_USER; B = await makeUser('b@x.test');
  acct = await makeAccount('a@demo.test', { userId: A });
  inbox = await makeMailbox(acct, 'INBOX', 'inbox'); trash = await makeMailbox(acct, 'Trash', 'trash');
  sale = await insertId("INSERT INTO labels(user_id, name, retention_days) VALUES (?, 'Sale', 7)", [A]);
  receipts = await insertId("INSERT INTO labels(user_id, name, protected) VALUES (?, 'Receipts', true)", [A]);
  const p = await insertId("INSERT INTO ai_providers(user_id, name, base_url, api_key_enc, model) VALUES (?, 'stub', 'http://stub.test/v1', '', 'stub-model')", [A]);
  for (const t of ['classify', 'embed']) await run('INSERT INTO ai_tasks(user_id, task, provider_id, model, enabled) VALUES (?,?,?,?,true)', [A, t, p, '']);
  vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
    fetchCalls++;
    const body = JSON.parse(init.body);
    if (String(url).endsWith('/embeddings')) return new Response(JSON.stringify({ data: [{ embedding: fakeEmbedding(String(body.input)) }] }), { status: 200 });
    if (llmFails) return new Response('boom', { status: 500 });
    const v = { category: 'marketing', label: 'Sale', is_real_document: false, requires_action: false, worth_keeping: false, retention: 'keep', warranty_months: null, confidence: 0.92, reason: 'looks like a promotion' };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(v) } }] }), { status: 200 });
  }));
  app = await makeApp();
  cka = await login(app, 'test@local'); ckb = await login(app, 'b@x.test');
});
afterEach(async () => { vi.unstubAllGlobals(); await setStoredMode('live'); });

const add = async (subject: string, body = 'new gadget quarterly newsletter acme offers', from = 'news@acme.test', acc = acct, box = inbox) => {
  const m = await ingest(acc, box, rawEmail({ from, to: 'a@demo.test', subject, body, date: 'Mon, 01 Jun 2026 10:00:00 +0000' }));
  return m!.rowId;
};
const labelsOf = async (id: number) => (await q<{ label_id: number }>('SELECT label_id FROM message_labels WHERE message_id = ? ORDER BY label_id', [id])).map((l) => l.label_id);

describe('why? (explanation data)', () => {
  it('shows rule, AI and similar-mail filings; hides pending and hand-filed mail', async () => {
    await insertId(`INSERT INTO rules(user_id, enabled, ord, match_field, match_value, action, label_id, stop, created_at) VALUES (?, true, 1, 'from_domain', 'shop.test', 'label', ?, true, 0)`, [A, sale]);
    const byRule = await add('Deal', 'x', 'a@shop.test');
    const byAi = await add('Hello there', 'plain', 'x@other.test');
    const pending = await add('Pending one', 'p', 'p@other.test');
    await run("UPDATE messages SET classify_state = 'classified' WHERE id = ?", [pending]);   // keep it out of this run
    await processPending();
    await run("UPDATE messages SET classify_state = 'pending' WHERE id = ?", [pending]);

    const r = (await api(cka, 'GET', `/api/message/m${byRule}/why`)).json();
    expect(r).toMatchObject({ visible: true, filedBy: 'rule', corrected: false });
    expect(r.rule.field).toBe('from_domain'); expect(r.rule.value).toBe('shop.test'); expect(r.labels.map((l: any) => l.name)).toEqual(['Sale']);
    const a = (await api(cka, 'GET', `/api/message/m${byAi}/why`)).json();
    expect(a).toMatchObject({ visible: true, filedBy: 'ai', model: 'stub-model', reason: 'looks like a promotion' });
    expect(a.confidence).toBeCloseTo(0.92, 2);
    // nothing decided yet -> hidden
    expect((await api(cka, 'GET', `/api/message/m${pending}/why`)).json()).toEqual({ visible: false });
    // filed by hand -> hidden
    await setLabels(A, `m${pending}`, [receipts]);
    expect((await api(cka, 'GET', `/api/message/m${pending}/why`)).json()).toEqual({ visible: false });
  });
});

describe('Fix it', () => {
  it('stores decision + heavy vector, sets user_touched, and the next similar mail takes the corrected label', async () => {
    const id = await add('Quarterly newsletter from Acme');
    await processPending();
    expect(await labelsOf(id)).toEqual([sale]);

    const res = (await api(cka, 'POST', `/api/message/m${id}/correct`, { labelId: receipts, remember: true, why: 'Acme newsletters are receipts for me' })).json();
    expect(res).toMatchObject({ ok: true, remembered: true });
    expect(await labelsOf(id)).toEqual([receipts]);
    const m = await one<any>('SELECT user_touched, disposition FROM messages WHERE id = ?', [id]);
    expect(m.user_touched).toBe(true); expect(m.disposition).toBe('keep');
    const d = await one<any>("SELECT * FROM ai_decisions WHERE email_id = ? AND tier = 'user'", [id]);
    expect(Number(d.confidence)).toBe(1);
    const v = await one<any>('SELECT * FROM email_vectors WHERE message_id = ?', [id]);
    expect(v).toMatchObject({ label_id: receipts, corrected: true }); expect(Number(v.weight)).toBeGreaterThan(1);
    expect(await one("SELECT 1 FROM preferences WHERE user_id = ? AND guidance LIKE 'Acme newsletters%' AND active", [A])).toBeTruthy();
    const w = (await api(cka, 'GET', `/api/message/m${id}/why`)).json();
    expect(w).toMatchObject({ visible: true, corrected: true });

    // the next similar message follows the correction, not the older AI verdict
    const next = await add('Quarterly newsletter from Acme', 'new gadget quarterly newsletter acme offers today');
    await processPending();
    expect(await labelsOf(next)).toEqual([receipts]);
    const dec = await one<any>("SELECT * FROM ai_decisions WHERE email_id = ? AND tier = 'embedding'", [next]);
    expect(dec.reason).toMatch(/corrected/);
    const w2 = (await api(cka, 'GET', `/api/message/m${next}/why`)).json();
    expect(w2.filedBy).toBe('similar'); expect(w2.similar.subject).toBe('Quarterly newsletter from Acme');
  });

  it('supports "no label" and a delete-after-N-days choice, and can be undone', async () => {
    const id = await add('Promo');
    await processPending();
    const before = await one<any>('SELECT disposition, delete_at, keep_reason, user_touched FROM messages WHERE id = ?', [id]);
    const res = (await api(cka, 'POST', `/api/message/m${id}/correct`, { labelId: null, retention: { mode: 'delete', days: 10 }, why: 'promos go' })).json();
    expect(await labelsOf(id)).toEqual([]);
    const m = await one<any>('SELECT disposition, delete_at, user_touched FROM messages WHERE id = ?', [id]);
    expect(m.disposition).toBe('delete'); expect(Number(m.delete_at)).toBe(Date.parse('Mon, 01 Jun 2026 10:00:00 +0000') + 10 * 86_400_000);
    expect((await api(cka, 'GET', '/api/corrections')).json()).toHaveLength(1);

    expect((await api(cka, 'POST', `/api/corrections/${res.correctionId}/undo`)).statusCode).toBe(200);
    expect(await labelsOf(id)).toEqual([sale]);
    const back = await one<any>('SELECT disposition, delete_at, keep_reason, user_touched FROM messages WHERE id = ?', [id]);
    expect(back).toEqual(before);
    expect(await one("SELECT 1 FROM ai_decisions WHERE email_id = ? AND tier = 'user'", [id])).toBeFalsy();
    expect(await one("SELECT 1 FROM preferences WHERE user_id = ? AND guidance = 'promos go' AND active", [A])).toBeFalsy();
    expect((await api(cka, 'GET', '/api/corrections')).json()).toHaveLength(0);
    expect((await api(cka, 'POST', `/api/corrections/${res.correctionId}/undo`)).statusCode).toBe(404);   // already undone
  });

  it('undo removes the heavy vector it added', async () => {
    const id = await add('Quarterly newsletter from Acme');
    await processPending();
    const res = (await api(cka, 'POST', `/api/message/m${id}/correct`, { labelId: receipts })).json();
    expect((await one<any>('SELECT corrected FROM email_vectors WHERE message_id = ?', [id])).corrected).toBe(true);
    await api(cka, 'DELETE', `/api/corrections/${res.correctionId}`);
    const v = await one<any>('SELECT * FROM email_vectors WHERE message_id = ?', [id]);
    expect(v?.corrected ?? false).toBe(false);
  });

  it('"remember" off stores no vector; three similar corrections offer a rule', async () => {
    const ids = [await add('One', 'a', 'n@acme.test'), await add('Two', 'b', 'm@acme.test'), await add('Three', 'c', 'o@acme.test')];
    await processPending();
    const r1 = (await api(cka, 'POST', `/api/message/m${ids[0]}/correct`, { labelId: receipts, remember: false })).json();
    expect(r1.remembered).toBe(false); expect(r1.offerRule).toBeNull();
    expect(await one('SELECT 1 FROM email_vectors WHERE message_id = ? AND corrected', [ids[0]])).toBeFalsy();
    await api(cka, 'POST', `/api/message/m${ids[1]}/correct`, { labelId: receipts });
    const r3 = (await api(cka, 'POST', `/api/message/m${ids[2]}/correct`, { labelId: receipts })).json();
    expect(r3.offerRule).toMatchObject({ matchField: 'from_domain', matchValue: 'acme.test', labelId: receipts });
    expect((await api(cka, 'POST', `/api/suggestions/${r3.offerRule.suggestionId}/accept`)).json().ok).toBe(true);
  });

  it('a hand relabel and a hand move are corrections too', async () => {
    const id = await add('Quarterly newsletter from Acme');
    const other = await add('Quarterly newsletter again', 'other body', 'z@z.test');
    const unfiled = await add('Nobody filed me', 'q', 'q@q.test');
    await processPending();
    await run("DELETE FROM ai_decisions WHERE email_id = ?", [unfiled]);
    await setLabels(A, `m${id}`, [receipts]);
    const c = await one<any>("SELECT * FROM corrections WHERE email_id = ? AND source = 'label'", [id]);
    expect(c).toBeTruthy();
    expect(await one("SELECT 1 FROM ai_decisions WHERE email_id = ? AND tier = 'user'", [id])).toBeTruthy();
    expect((await one<any>('SELECT label_id, corrected FROM email_vectors WHERE message_id = ?', [id]))).toMatchObject({ label_id: receipts, corrected: true });

    await moveEmail(A, `m${other}`, 'u:trash');
    expect(await one("SELECT 1 FROM corrections WHERE email_id = ? AND source = 'move'", [other])).toBeTruthy();
    await moveEmail(A, `m${unfiled}`, 'u:trash');
    expect(await one("SELECT 1 FROM corrections WHERE email_id = ?", [unfiled])).toBeFalsy();   // moving mail nobody filed is just moving
  });
});

describe('isolation', () => {
  it('user B cannot read, correct or undo user A\'s corrections', async () => {
    const id = await add('Quarterly newsletter from Acme');
    await processPending();
    const res = (await api(cka, 'POST', `/api/message/m${id}/correct`, { labelId: receipts })).json();
    expect((await api(ckb, 'GET', `/api/message/m${id}/why`)).json()).toEqual({ visible: false });
    expect([403, 404]).toContain((await api(ckb, 'POST', `/api/message/m${id}/correct`, { labelId: null })).statusCode);
    expect((await api(ckb, 'GET', '/api/corrections')).json()).toEqual([]);
    expect((await api(ckb, 'POST', `/api/corrections/${res.correctionId}/undo`)).statusCode).toBe(404);
    expect((await api(ckb, 'GET', '/api/ai/health')).json()).toMatchObject({ waiting: 0 });
    expect(await labelsOf(id)).toEqual([receipts]);
  });
});

describe('health line', () => {
  it('counts waiting / failed / last verdict, goes red + alerts when stuck, and Retry now requeues', async () => {
    const id = await add('Hello');
    await processPending();
    const p1 = await add('Waiting 1'); await add('Waiting 2');
    await run("UPDATE messages SET classify_state = 'pending' WHERE id > ?", [id]);
    let h = (await api(cka, 'GET', '/api/ai/health')).json();
    expect(h).toMatchObject({ waiting: 2, failed: 0, stuck: false, status: 'ok' });
    expect(Date.now() - h.lastVerdictAt).toBeLessThan(60_000);

    await run("UPDATE messages SET classify_state = 'needs_review', review_reason = 'AI classification failed' WHERE id = ?", [p1]);
    expect((await aiHealth(A)).failed).toBe(1);

    await noteAiError(A, 'classify: HTTP 500');
    await run("UPDATE messages SET created_at = ? WHERE classify_state = 'pending'", [Date.now() - 45 * 60_000]);
    h = await aiHealth(A);
    expect(h.stuck).toBe(true); expect(h.status).toBe('red');
    await runAlertChecks();
    const al = await one<any>("SELECT * FROM alerts WHERE kind = 'ai.backlog' AND state = 'open'");
    expect(al.user_id).toBe(A); expect(al.title).toBe('AI backlog stuck');

    const retry = (await api(cka, 'POST', '/api/ai/retry')).json();
    expect(retry.queued).toBe(1);
    await noteAiError(A, null);
    await run("UPDATE messages SET classify_state = 'classified' WHERE user_id = ?", [A]);
    await runAlertChecks();
    expect(await one("SELECT 1 FROM alerts WHERE kind = 'ai.backlog' AND state = 'open'")).toBeFalsy();
  });

  it('a different embedding dimension queues lazy re-embedding and nothing is dropped', async () => {
    const id = await add('Quarterly newsletter from Acme');
    await processPending();
    await api(cka, 'POST', `/api/message/m${id}/correct`, { labelId: receipts });
    expect((await one<any>('SELECT dim FROM email_vectors WHERE message_id = ?', [id])).dim).toBe(64);
    DIM = 32;                                             // the provider changed
    await noteEmbedDim(A, 32);
    expect((await aiHealth(A)).relearning).toBe(1);
    expect((await one<any>('SELECT COUNT(*)::int c FROM email_vectors')).c).toBe(1);
    expect(await relearnBatch()).toBe(1);
    expect((await one<any>('SELECT dim, corrected FROM email_vectors WHERE message_id = ?', [id]))).toMatchObject({ dim: 32, corrected: true });
    expect((await aiHealth(A)).relearning).toBe(0);
  });
});

describe('backups carry the AI memory', () => {
  it('ai_decisions, email_vectors, preferences, rules and newsletter_senders survive create -> restore with equal counts', async () => {
    const id = await add('Quarterly newsletter from Acme');
    await processPending();
    await api(cka, 'POST', `/api/message/m${id}/correct`, { labelId: receipts, why: 'keep Acme' });
    await insertId(`INSERT INTO rules(user_id, enabled, ord, match_field, match_value, action, label_id, stop, created_at) VALUES (?, true, 1, 'from_domain', 'acme.test', 'label', ?, true, 0)`, [A, receipts]);
    await run("INSERT INTO newsletter_senders(user_id, sender, choice, created_at) VALUES (?, 'news@acme.test', 'read_later', 0)", [A]);
    const tables = ['ai_decisions', 'email_vectors', 'preferences', 'rules', 'newsletter_senders'];
    const count = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, (await one<any>(`SELECT COUNT(*)::int c FROM ${t}`)).c])));
    const store = {
      put: async (k: string, b: Buffer) => { blobStore.set(k, b); }, get: async (k: string) => { const b = blobStore.get(k); if (!b) throw new Error('no blob'); return b; },
      list: async (p: string) => [...blobStore.keys()].filter((k) => k.startsWith(p)).sort(), del: async (k: string) => { blobStore.delete(k); },
    };
    const manifest = await createBackup({ prefix: 'backup/', store, appVersion: 'test' });
    const before = await count();
    expect(before.ai_decisions).toBeGreaterThan(1); expect(before.email_vectors).toBe(1);
    const vec = await one<any>('SELECT dim, weight, corrected, model FROM email_vectors');
    await run('DROP SCHEMA public CASCADE'); await run('CREATE SCHEMA public');
    await restoreBackup(manifest.key, { store });
    expect(await count()).toEqual(before);
    expect(await one<any>('SELECT dim, weight, corrected, model FROM email_vectors')).toEqual(vec);   // dim/model kept, re-embedded lazily
  });
});

describe('archives carry the AI memory', () => {
  it('exports ai/ files and imports them as a merge; Viewing mode shows the explanation without any AI call', async () => {
    const id = await add('Quarterly newsletter from Acme');
    await processPending();
    await api(cka, 'POST', `/api/message/m${id}/correct`, { labelId: receipts, why: 'keep Acme' });
    await insertId(`INSERT INTO rules(user_id, enabled, ord, match_field, match_value, action, label_id, stop, created_at) VALUES (?, true, 1, 'from_domain', 'acme.test', 'label', ?, true, 0)`, [A, receipts]);
    await run("INSERT INTO newsletter_senders(user_id, sender, choice, created_at) VALUES (?, 'news@acme.test', 'read_later', 0)", [A]);
    await run("UPDATE labels SET retention_days = 30 WHERE id = ?", [sale]);

    const objs = new Map<string, Buffer>();
    const store: any = { put: async (k: string, b: Buffer) => { objs.set(k, b); }, get: async (k: string) => { const b = objs.get(k); if (!b) throw new Error('NoSuchKey'); return b; }, list: async () => [...objs.keys()], del: async () => {} };
    const info = await writeAiMemory(A, 'archive/9/', store, [id]);
    expect(info.decisions).toBeGreaterThanOrEqual(2); expect(info.vectors).toBe(1);
    expect([...objs.keys()].sort()).toEqual(['archive/9/ai/ai_decisions.jsonl', 'archive/9/ai/email_vectors.jsonl', 'archive/9/ai/memory.json']);
    expect(objs.get('archive/9/ai/memory.json')!.toString()).not.toMatch(/api_key|secret/i);

    // "another instance": user B, viewing mode
    await setStoredMode('viewing');
    const bAcct = await makeAccount('arch@demo.test', { userId: B });
    const bBox = await makeMailbox(bAcct, 'INBOX', 'inbox');
    const bMsg = (await ingest(bAcct, bBox, rawEmail({ from: 'news@acme.test', to: 'a@demo.test', subject: 'Quarterly newsletter from Acme', body: 'x' })))!.rowId;
    const imp = await insertId("INSERT INTO archive_imports(user_id, source_kind, source_ref, archive_path, name, status, options, summary, created_at) VALUES (?, 'folder', '', 'x/', 'x', 'running', '{}'::jsonb, '{}'::jsonb, 0)", [B]);
    await run("INSERT INTO mail_archive_imports(import_id, message_key, message_id, state) VALUES (?,?,?, 'imported')", [imp, `M${id}`, bMsg]);
    const bLabels = new Map<string, number>();
    const bRec = await insertId("INSERT INTO labels(user_id, name, protected) VALUES (?, 'Receipts', true)", [B]);
    const bSale = await insertId("INSERT INTO labels(user_id, name) VALUES (?, 'Sale')", [B]);
    bLabels.set(`L${receipts}`, bRec); bLabels.set(`L${sale}`, bSale);
    const m = { ai_memory: true, ai: { prefix: 'archive/9/' } };
    const rb = (p: string) => p;
    const s1 = await importAiSettings(B, store, rb, m, bLabels);
    const s2 = await importAiMessages(B, store, rb, m, imp, bLabels);
    expect(s1.created).toBeGreaterThanOrEqual(4);   // preference, rule, label retention, newsletter sender
    expect(await one("SELECT 1 FROM preferences WHERE user_id = ? AND guidance = 'keep Acme'", [B])).toBeTruthy();
    expect(await one("SELECT 1 FROM rules WHERE user_id = ? AND match_value = 'acme.test'", [B])).toBeTruthy();
    expect((await one<any>('SELECT retention_days FROM labels WHERE id = ?', [bSale])).retention_days).toBe(30);
    expect(await one("SELECT 1 FROM newsletter_senders WHERE user_id = ? AND sender = 'news@acme.test'", [B])).toBeTruthy();
    expect(s2.decisions).toBeGreaterThanOrEqual(2); expect(s2.vectors).toBe(1);

    // importing again merges: nothing duplicates
    const again = await importAiSettings(B, store, rb, m, bLabels);
    const again2 = await importAiMessages(B, store, rb, m, imp, bLabels);
    expect(again.created).toBe(0); expect(again2).toEqual({ decisions: 0, vectors: 0 });

    // viewing mode: explanation is served from the stored decision, the classifier never runs
    await run("UPDATE messages SET classify_state = 'pending' WHERE id = ?", [bMsg]);
    fetchCalls = 0;
    expect(await processPending()).toBe(0);
    expect((await one<any>('SELECT classify_state FROM messages WHERE id = ?', [bMsg])).classify_state).toBe('pending');
    const w = (await api(ckb, 'GET', `/api/message/m${bMsg}/why`)).json();
    expect(w.visible).toBe(true); expect(w.filedBy).toBeTruthy();
    expect(fetchCalls).toBe(0);
    // a correction in viewing mode is saved but makes no AI call
    const r = (await api(ckb, 'POST', `/api/message/m${bMsg}/correct`, { labelId: bRec })).json();
    expect(r.ok).toBe(true); expect(r.remembered).toBe(false); expect(fetchCalls).toBe(0);
  });
});
