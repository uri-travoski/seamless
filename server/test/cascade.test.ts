import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import { resetDb, makeAccount, makeMailbox, ingest, rawEmail, TEST_USER } from './helpers.ts';
import { q, one, run, insertId } from '../src/db.ts';
import { processPending } from '../src/classify/engine.ts';
import { setLabels } from '../src/mail/store.ts';

// deterministic fake embedding (same algorithm as scripts/ai-stub.ts)
function fakeEmbedding(text: string, dim = 64): number[] {
  const vec = new Array(dim).fill(0);
  for (const w of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    const h = crypto.createHash('md5').update(w).digest();
    for (let i = 0; i < 8; i++) vec[h[i] % dim] += (h[(i + 8) % 16] / 128) - 1;
  }
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map((x) => x / norm);
}

function verdictFor(user: string): any {
  const real = /itemised|receipt total|invoice #/i.test(user);
  const action = /suspend|action required/i.test(user);
  return {
    category: real ? 'receipt' : 'notification',
    label: real ? 'Receipts' : null,
    is_real_document: real,
    requires_action: action,
    worth_keeping: real || action,
    retention: real || action ? 'keep' : 'delete',
    warranty_months: /2-year warranty/i.test(user) ? 24 : null,
    confidence: /make me unsure/i.test(user) ? 0.3 : 0.9,
    reason: real ? 'itemised document' : action ? 'actionable' : 'notice only',
  };
}

let acct: number, inbox: number, userId: number, receiptsLabel: number, saleLabel: number;

beforeAll(async () => {
  await resetDb();
  userId = TEST_USER;
  acct = await makeAccount('alice@demo.test');
  inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  await makeMailbox(acct, 'Trash', 'trash');
  receiptsLabel = await insertId("INSERT INTO labels(user_id, name, protected) VALUES (?, 'Receipts', true)", [userId]);
  saleLabel = await insertId("INSERT INTO labels(user_id, name, retention_days) VALUES (?, 'Sale', 10)", [userId]);
  await insertId("INSERT INTO labels(user_id, name, retention_days) VALUES (?, 'To Delete', 60)", [userId]);
  // ai-routed rule (mixed sender)
  await insertId(`INSERT INTO rules(user_id, enabled, ord, match_field, match_value, action, label_id, stop, note, created_at)
    VALUES (?, true, 1, 'subject_contains', 'payment successful', 'ai', NULL, true, 'AI: To Delete unless real invoice', 0)`, [userId]);

  // wire both AI tasks at a fake endpoint served by the fetch mock below
  const p = await insertId("INSERT INTO ai_providers(user_id, name, base_url, api_key_enc, model) VALUES (?, 'stub', 'http://stub.test/v1', '', 'stub-model')", [userId]);
  for (const t of ['classify', 'embed']) {
    await run('INSERT INTO ai_tasks(user_id, task, provider_id, model, enabled) VALUES (?,?,?,?,true)', [userId, t, p, '']);
  }

  vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith('/embeddings')) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({ data: inputs.map((t: string, i: number) => ({ index: i, embedding: fakeEmbedding(t) })) }), { status: 200 });
    }
    const user = body.messages.find((m: any) => m.role === 'user')?.content ?? '';
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdictFor(user)) } }] }), { status: 200 });
  }));
});

afterAll(() => vi.unstubAllGlobals());

describe('full cascade', () => {
  it('ai-routed payment notice without document -> To Delete via LLM verdict', async () => {
    const m = await ingest(acct, inbox, rawEmail({
      from: 'noreply@vendor.test', to: 'alice@demo.test', subject: 'Payment successful',
      body: 'Your payment was processed. Thanks!', date: 'Wed, 01 Jul 2026 10:00:00 +0000',
    }));
    await processPending();
    const row = await one<any>('SELECT * FROM messages WHERE id = ?', [m!.rowId]);
    expect(row.classify_state).toBe('classified');
    expect(row.disposition).toBe('delete'); // verdict retention 'delete' -> 30d default
    expect(row.delete_at).toBe(Date.parse('Wed, 01 Jul 2026 10:00:00 +0000') + 30 * 86_400_000);
    const dec = await one<any>("SELECT * FROM ai_decisions WHERE email_id = ? AND tier = 'llm'", [m!.rowId]);
    expect(dec).toBeTruthy();
    expect(JSON.parse(dec.output).is_real_document).toBe(false);
  });

  it('same subject WITH itemised content -> Receipts, keep (the hard pair)', async () => {
    const m = await ingest(acct, inbox, rawEmail({
      from: 'billing@vendor2.test', to: 'alice@demo.test', subject: 'Payment successful',
      body: 'Invoice #991 receipt total $30. Itemised: Widget x3.',
    }));
    await processPending();
    const row = await one<any>('SELECT * FROM messages WHERE id = ?', [m!.rowId]);
    expect(row.disposition).toBe('keep');
    const labels = await q<any>('SELECT label_id FROM message_labels WHERE message_id = ?', [m!.rowId]);
    expect(labels.map((l: any) => l.label_id)).toContain(receiptsLabel);
  });

  it('low-confidence verdict lands in the review lane, never deleted', async () => {
    const m = await ingest(acct, inbox, rawEmail({
      from: 'x@odd.test', to: 'alice@demo.test', subject: 'payment successful make me unsure',
      body: 'make me unsure please',
    }));
    await processPending();
    const row = await one<any>('SELECT * FROM messages WHERE id = ?', [m!.rowId]);
    expect(row.classify_state).toBe('needs_review');
    expect(row.disposition).toBe('keep');
    expect(row.review_reason).toContain('AI unsure');
  });

  it('embedding tier catches unmatched mail similar to labelled history', async () => {
    // seed the memory: three labelled Sale-ish messages
    for (let i = 0; i < 3; i++) {
      const seed = await ingest(acct, inbox, rawEmail({
        from: `deals${i}@shop.test`, to: 'alice@demo.test',
        subject: 'weekly deals savings discount offers bargain',
        body: 'deals savings discount offers bargain shopping specials',
      }));
      const { upsertVector } = await import('../src/classify/ai.ts');
      await upsertVector(userId, seed!.rowId, saleLabel, fakeEmbedding(`from: deals${i}@shop.test\nsubject: weekly deals savings discount offers bargain\ndeals savings discount offers bargain shopping specials`.slice(0, 1500)));
      await run("UPDATE messages SET classify_state = 'classified' WHERE id = ?", [seed!.rowId]);
    }
    const m = await ingest(acct, inbox, rawEmail({
      from: 'newshop@other.test', to: 'alice@demo.test',
      subject: 'weekly deals savings discount offers bargain',
      body: 'deals savings discount offers bargain shopping specials',
    }));
    await processPending();
    const labels = await q<any>('SELECT label_id FROM message_labels WHERE message_id = ?', [m!.rowId]);
    expect(labels.map((l: any) => l.label_id)).toContain(saleLabel);
    const dec = await one<any>("SELECT * FROM ai_decisions WHERE email_id = ? AND tier = 'embedding'", [m!.rowId]);
    expect(dec).toBeTruthy();
    expect(dec.confidence).toBeGreaterThan(0.88);
  });

  it('warranty verdict extends retention to the warranty window', async () => {
    const m = await ingest(acct, inbox, rawEmail({
      from: 'store@gadget.test', to: 'alice@demo.test', subject: 'payment successful',
      body: 'Your gadget order. Comes with a 2-year warranty. No invoice attached.',
      date: 'Wed, 01 Jul 2026 10:00:00 +0000',
    }));
    await processPending();
    const row = await one<any>('SELECT * FROM messages WHERE id = ?', [m!.rowId]);
    expect(row.disposition).toBe('delete');
    const days = Math.round((row.delete_at - Date.parse('Wed, 01 Jul 2026 10:00:00 +0000')) / 86_400_000);
    expect(days).toBeGreaterThanOrEqual(720); // ~24 months, not 30 days
  });
});

describe('processor notes', () => {
  it('sender note applies label, auto-read, retention and delete-if-unread', async () => {
    await insertId(`
      INSERT INTO processor_notes(user_id, scope, scope_value, note, label_id, auto_read, retention_days, delete_if_unread, active, created_at, updated_at)
      VALUES (?, 'sender', 'digest@weekly.test', 'newsletter I signed up for', ?, true, 7, true, true, 0, 0)
    `, [userId, saleLabel]);
    const m = await ingest(acct, inbox, rawEmail({
      from: 'digest@weekly.test', to: 'alice@demo.test', subject: 'This week in things',
      date: 'Wed, 01 Jul 2026 10:00:00 +0000',
    }));
    await processPending();
    const row = await one<any>('SELECT * FROM messages WHERE id = ?', [m!.rowId]);
    expect(row.unread).toBe(false);
    expect(row.disposition).toBe('delete');
    expect(row.delete_at).toBe(Date.parse('Wed, 01 Jul 2026 10:00:00 +0000') + 7 * 86_400_000);
    expect(row.delete_if_unread).toBe(true);
    const labels = await q<any>('SELECT label_id FROM message_labels WHERE message_id = ?', [m!.rowId]);
    expect(labels.map((l: any) => l.label_id)).toContain(saleLabel);
  });
});

describe('corrections -> rule suggestions', () => {
  it('3 same-domain corrections suggest a from_domain rule', async () => {
    for (let i = 0; i < 3; i++) {
      const m = await ingest(acct, inbox, rawEmail({
        from: `sender${i}@corrections.test`, to: 'alice@demo.test', subject: `Note ${i}`,
      }));
      await run("UPDATE messages SET classify_state = 'classified' WHERE id = ?", [m!.rowId]);
      await setLabels(userId, `m${m!.rowId}`, [saleLabel]);
    }
    const sugg = await one<any>("SELECT * FROM rule_suggestions WHERE user_id = ? AND match_value = 'corrections.test'", [userId]);
    expect(sugg).toBeTruthy();
    expect(sugg.label_id).toBe(saleLabel);
    expect(sugg.evidence).toBeGreaterThanOrEqual(3);
    const corr = await q<any>("SELECT * FROM corrections WHERE user_id = ? AND from_domain = 'corrections.test'", [userId]);
    expect(corr.length).toBe(3);
  });
});
