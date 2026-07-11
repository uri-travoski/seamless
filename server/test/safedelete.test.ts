import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, makeAccount, makeMailbox, ingest, rawEmail, blobStore, TEST_USER } from './helpers.ts';
import { q, one, run } from '../src/db.ts';
import { sweepSafeDelete, verifyBlob, safeDeletePreview } from '../src/classify/safedelete.ts';
import { analyseSamples } from '../src/import/gmailLearn.ts';

let acct: number, inbox: number;

beforeAll(async () => {
  await resetDb();
  acct = await makeAccount('alice@demo.test');
  inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  await makeMailbox(acct, 'Trash', 'trash');
});

describe('safe delete', () => {
  it('does nothing while the account toggle is off', async () => {
    const m = await ingest(acct, inbox, rawEmail({
      from: 'x@old.test', to: 'alice@demo.test', subject: 'Old imported', date: 'Mon, 01 Jan 2026 10:00:00 +0000',
    }));
    await run("UPDATE messages SET classify_state = 'classified' WHERE id = ?", [m!.rowId]);
    const stats = await sweepSafeDelete(Date.parse('2026-07-01'));
    expect(stats.removed).toBe(0);
    expect((await one<any>('SELECT origin_state FROM messages WHERE id = ?', [m!.rowId]))!.origin_state).toBe('present');
  });

  it('verified + aged mail is removed at the origin; local copy becomes the record', async () => {
    await run('UPDATE accounts SET safe_delete_enabled = true, safe_delete_grace_days = 30 WHERE id = ?', [acct]);
    const preview = await safeDeletePreview(TEST_USER, acct);
    expect(preview.count).toBe(1);

    const stats = await sweepSafeDelete(Date.parse('2026-07-01'));
    expect(stats.removed).toBe(1);
    const row = await one<any>("SELECT * FROM messages WHERE subject = 'Old imported'");
    expect(row.origin_state).toBe('removed');
    expect(row.uid).toBeLessThan(0); // placeholder: sync ignores it forever
    const ops = await q<any>("SELECT * FROM op_queue WHERE op = 'move'");
    expect(ops.some((o) => JSON.parse(o.payload).targetRole === 'trash')).toBe(true);
  });

  it('recent mail stays at the origin (grace window)', async () => {
    const m = await ingest(acct, inbox, rawEmail({
      from: 'x@new.test', to: 'alice@demo.test', subject: 'Fresh', date: 'Mon, 29 Jun 2026 10:00:00 +0000',
    }));
    await run("UPDATE messages SET classify_state = 'classified' WHERE id = ?", [m!.rowId]);
    const stats = await sweepSafeDelete(Date.parse('2026-07-01'));
    expect(stats.removed).toBe(0);
  });

  it('refuses to remove when the archive blob fails verification', async () => {
    const m = await ingest(acct, inbox, rawEmail({
      from: 'x@corrupt.test', to: 'alice@demo.test', subject: 'Corrupt blob', date: 'Mon, 01 Jan 2026 10:00:00 +0000',
    }));
    await run("UPDATE messages SET classify_state = 'classified' WHERE id = ?", [m!.rowId]);
    const row = await one<any>('SELECT s3_key FROM messages WHERE id = ?', [m!.rowId]);
    blobStore.set(row.s3_key, Buffer.from('tampered')); // corrupt the archive copy
    const stats = await sweepSafeDelete(Date.parse('2026-07-01'));
    expect(stats.failedVerify).toBe(1);
    expect((await one<any>('SELECT origin_state FROM messages WHERE id = ?', [m!.rowId]))!.origin_state).toBe('present');
  });

  it('verifyBlob checks the digest embedded in the key', async () => {
    const raw = rawEmail({ from: 'a@b.test', to: 'c@d.test', subject: 'v' });
    const { sha256 } = await import('../src/crypto.ts');
    const key = `msg/1/${sha256(raw)}.eml`;
    blobStore.set(key, raw);
    expect(await verifyBlob(key)).toBe(true);
    blobStore.set(key, Buffer.concat([raw, Buffer.from('x')]));
    expect(await verifyBlob(key)).toBe(false);
    expect(await verifyBlob('msg/1/nothash.eml')).toBe(false);
  });
});

describe('gmail learn analysis', () => {
  const sample = (from: string, label: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      from, fromDomain: from.split('@')[1], subject: `s${i}`, snippet: 'x', label,
    }));

  it('consistent senders become rules; whole-domain agreement rolls up', () => {
    const proposals = analyseSamples([
      ...sample('statements@anz.test', 'Banking', 10),
      ...sample('alerts@anz.test', 'Banking', 6),
      ...sample('deals@shop.test', 'Sale', 5),
    ]);
    const domain = proposals.find((p) => p.matchField === 'from_domain' && p.matchValue === 'anz.test');
    expect(domain?.kind).toBe('rule');
    expect(domain?.label).toBe('Banking');
    const sender = proposals.find((p) => p.matchValue === 'deals@shop.test');
    expect(sender?.kind).toBe('rule');
    expect(sender?.label).toBe('Sale');
    // rolled-up senders don't also get individual rules
    expect(proposals.some((p) => p.matchValue === 'statements@anz.test')).toBe(false);
  });

  it('mixed senders are routed to AI with their split', () => {
    const proposals = analyseSamples([
      ...sample('noreply@play.test', 'Receipts', 6),
      ...sample('noreply@play.test', 'Service Notifications', 5),
    ]);
    const ai = proposals.find((p) => p.matchValue === 'noreply@play.test');
    expect(ai?.kind).toBe('ai');
    expect(ai?.split).toEqual({ Receipts: 6, 'Service Notifications': 5 });
  });

  it('thin evidence is ignored', () => {
    const proposals = analyseSamples(sample('once@rare.test', 'Sale', 2));
    expect(proposals.length).toBe(0);
  });
});
