import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeAccount, makeMailbox, ingest, rawEmail, TEST_USER } from './helpers.ts';
import { q, one, run, insertId } from '../src/db.ts';
import { ruleMatches, baseAddress, evaluateRules, type MatchableMessage } from '../src/classify/rules.ts';
import { processPending, recomputeDisposition } from '../src/classify/engine.ts';
import { sweepRetention } from '../src/classify/retention.ts';
import { setUserSetting } from '../src/classify/settings.ts';
import { setKeywords, moveEmail } from '../src/mail/store.ts';

const msg = (over: Partial<MatchableMessage> = {}): MatchableMessage => ({
  fromAddr: 'noreply@stripe.com', toAddrs: ['me@demo.test'], deliveredTo: 'me@demo.test',
  subject: 'Your receipt', body: 'Amount charged: $10', headers: {}, ...over,
});

describe('rule matching', () => {
  it('from is exact, from_domain matches subdomains', () => {
    expect(ruleMatches(msg(), { match_field: 'from', match_value: 'noreply@stripe.com', exclude_contains: '' })).toBe(true);
    expect(ruleMatches(msg(), { match_field: 'from', match_value: 'stripe.com', exclude_contains: '' })).toBe(false);
    expect(ruleMatches(msg(), { match_field: 'from_domain', match_value: 'stripe.com', exclude_contains: '' })).toBe(true);
    expect(ruleMatches(msg({ fromAddr: 'x@mail.stripe.com' }), { match_field: 'from_domain', match_value: 'stripe.com', exclude_contains: '' })).toBe(true);
    expect(ruleMatches(msg({ fromAddr: 'x@notstripe.com' }), { match_field: 'from_domain', match_value: 'stripe.com', exclude_contains: '' })).toBe(false);
  });

  it('delivered_to collapses plus-tags to the base address', () => {
    expect(baseAddress('Really.Basic+aws@Gmail.com')).toBe('really.basic@gmail.com');
    expect(ruleMatches(msg({ deliveredTo: 'me+shop@demo.test' }), { match_field: 'delivered_to', match_value: 'me@demo.test', exclude_contains: '' })).toBe(true);
  });

  it('subject_contains + exclude_contains', () => {
    const r = { match_field: 'subject_contains', match_value: 'receipt', exclude_contains: 'tax invoice, statement' };
    expect(ruleMatches(msg(), r)).toBe(true);
    expect(ruleMatches(msg({ body: 'your statement is ready' }), r)).toBe(false);
  });

  it('header and category rules read raw headers', () => {
    const m = msg({ headers: { 'list-unsubscribe': '<https://x/unsub>', 'precedence': 'bulk' } });
    expect(ruleMatches(m, { match_field: 'category', match_value: 'promotions', exclude_contains: '' })).toBe(true);
    expect(ruleMatches(m, { match_field: 'header', match_value: 'precedence:bulk', exclude_contains: '' })).toBe(true);
    expect(ruleMatches(msg(), { match_field: 'category', match_value: 'promotions', exclude_contains: '' })).toBe(false);
  });

  it('evaluateRules respects ord and stop', () => {
    const base = { user_id: 1, enabled: true, exclude_contains: '', action: 'label' as const, label_id: 1, note: '', source: 'manual' };
    const rules = [
      { ...base, id: 1, ord: 20, match_field: 'from_domain', match_value: 'stripe.com', stop: true },
      { ...base, id: 2, ord: 10, match_field: 'subject_contains', match_value: 'receipt', stop: true },
      { ...base, id: 3, ord: 30, match_field: 'from_domain', match_value: 'stripe.com', stop: true },
    ];
    const matched = evaluateRules(msg(), rules as any);
    expect(matched.map((m) => m.id)).toEqual([2]); // ord 10 wins, stop halts
  });
});

describe('classification pipeline + retention', () => {
  let acct: number, inbox: number, trash: number, userId: number;
  let saleLabel: number, keepLabel: number;

  beforeEach(async () => {
    await resetDb();
    userId = TEST_USER;
    acct = await makeAccount('alice@demo.test');
    inbox = await makeMailbox(acct, 'INBOX', 'inbox');
    trash = await makeMailbox(acct, 'Trash', 'trash');
    saleLabel = await insertId("INSERT INTO labels(user_id, name, retention_days, auto_mark_read) VALUES (?, 'Sale', 10, true)", [userId]);
    keepLabel = await insertId("INSERT INTO labels(user_id, name, protected) VALUES (?, 'Receipts', true)", [userId]);
    await insertId(`INSERT INTO rules(user_id, enabled, ord, match_field, match_value, action, label_id, stop, created_at)
      VALUES (?, true, 10, 'from_domain', 'ozbargain.com.au', 'label', ?, true, 0)`, [userId, saleLabel]);
    await insertId(`INSERT INTO rules(user_id, enabled, ord, match_field, match_value, action, label_id, stop, created_at)
      VALUES (?, true, 20, 'from_domain', 'stripe.com', 'label', ?, true, 0)`, [userId, keepLabel]);
    await insertId(`INSERT INTO rules(user_id, enabled, ord, match_field, match_value, action, label_id, stop, created_at)
      VALUES (?, true, 30, 'from', 'transaction@notice.aliexpress.com', 'ai', NULL, true, 0)`, [userId]);
  });

  it('classifies pending mail: labels, auto-read, disposition, ai -> needs_review', async () => {
    const sale = await ingest(acct, inbox, rawEmail({ from: 'deals@ozbargain.com.au', to: 'alice@demo.test', subject: 'Deals!', date: 'Wed, 01 Jul 2026 10:00:00 +0000' }));
    const receipt = await ingest(acct, inbox, rawEmail({ from: 'noreply@stripe.com', to: 'alice@demo.test', subject: 'Receipt' }));
    const ali = await ingest(acct, inbox, rawEmail({ from: 'transaction@notice.aliexpress.com', to: 'alice@demo.test', subject: 'Order shipped' }));
    const plain = await ingest(acct, inbox, rawEmail({ from: 'friend@x.test', to: 'alice@demo.test', subject: 'Hi' }));

    await processPending();

    const saleRow = await one<any>('SELECT * FROM messages WHERE id = ?', [sale!.rowId]);
    expect(saleRow.disposition).toBe('delete');
    expect(saleRow.delete_at).toBe(Date.parse('Wed, 01 Jul 2026 10:00:00 +0000') + 10 * 86_400_000);
    expect(saleRow.unread).toBe(false); // auto_mark_read
    expect(saleRow.classify_state).toBe('classified');

    const receiptRow = await one<any>('SELECT * FROM messages WHERE id = ?', [receipt!.rowId]);
    expect(receiptRow.disposition).toBe('keep');
    expect(receiptRow.keep_reason).toContain('Receipts');

    const aliRow = await one<any>('SELECT * FROM messages WHERE id = ?', [ali!.rowId]);
    expect(aliRow.classify_state).toBe('needs_review');
    expect(aliRow.disposition).toBe('keep'); // never delete on a guess

    const plainRow = await one<any>('SELECT * FROM messages WHERE id = ?', [plain!.rowId]);
    expect(plainRow.classify_state).toBe('classified');
    expect(plainRow.disposition).toBe('keep');
  });

  it('retention sweep: dry-run logs only; live run trashes; protected + user_touched never touched', async () => {
    const old = await ingest(acct, inbox, rawEmail({ from: 'deals@ozbargain.com.au', to: 'alice@demo.test', subject: 'Old deal', date: 'Mon, 01 Jun 2026 10:00:00 +0000' }));
    const prot = await ingest(acct, inbox, rawEmail({ from: 'noreply@stripe.com', to: 'alice@demo.test', subject: 'Old receipt', date: 'Mon, 01 Jun 2026 10:00:00 +0000' }));
    await processPending();

    // dry run (default): nothing moves
    let stats = await sweepRetention(Date.parse('2026-07-10'));
    expect(stats.trashed).toBe(0);
    expect(stats.dryRun).toBeGreaterThan(0);
    let row = await one<any>('SELECT mailbox_id FROM messages WHERE id = ?', [old!.rowId]);
    expect(row.mailbox_id).toBe(inbox);
    const logs = await q("SELECT * FROM processing_logs WHERE kind = 'retention'");
    expect(logs.some((l: any) => l.message.includes('DRY RUN'))).toBe(true);

    // live run
    await setUserSetting(userId, 'dry_run', 'false');
    stats = await sweepRetention(Date.parse('2026-07-10'));
    expect(stats.trashed).toBe(1);
    row = await one<any>('SELECT mailbox_id, trashed_at FROM messages WHERE id = ?', [old!.rowId]);
    expect(row.mailbox_id).toBe(trash);
    expect(row.trashed_at).toBeTruthy();
    // protected receipt untouched
    const protRow = await one<any>('SELECT mailbox_id FROM messages WHERE id = ?', [prot!.rowId]);
    expect(protRow.mailbox_id).toBe(inbox);
  });

  it('manual unread sets user_touched and retention skips it', async () => {
    const m = await ingest(acct, inbox, rawEmail({ from: 'deals@ozbargain.com.au', to: 'alice@demo.test', subject: 'Deal', date: 'Mon, 01 Jun 2026 10:00:00 +0000' }));
    await processPending();
    await setKeywords(userId, `m${m!.rowId}`, { $seen: false }); // user pulls it back to unread
    await setUserSetting(userId, 'dry_run', 'false');
    const stats = await sweepRetention(Date.parse('2026-07-10'));
    expect(stats.trashed).toBe(0);
    const row = await one<any>('SELECT mailbox_id, disposition, user_touched FROM messages WHERE id = ?', [m!.rowId]);
    expect(row.mailbox_id).toBe(inbox);
    expect(row.user_touched).toBe(true);
    expect(row.disposition).toBe('keep');
  });

  it('restore from trash protects the message and clears the purge clock', async () => {
    const m = await ingest(acct, inbox, rawEmail({ from: 'deals@ozbargain.com.au', to: 'alice@demo.test', subject: 'Deal', date: 'Mon, 01 Jun 2026 10:00:00 +0000' }));
    await processPending();
    await setUserSetting(userId, 'dry_run', 'false');
    await sweepRetention(Date.parse('2026-07-10'));
    let row = await one<any>('SELECT mailbox_id FROM messages WHERE id = ?', [m!.rowId]);
    expect(row.mailbox_id).toBe(trash);

    await moveEmail(userId, `m${m!.rowId}`, `mb:${inbox}`); // user restores
    row = await one<any>('SELECT mailbox_id, trashed_at, user_touched, disposition FROM messages WHERE id = ?', [m!.rowId]);
    expect(row.mailbox_id).toBe(inbox);
    expect(row.trashed_at).toBe(null);
    expect(row.user_touched).toBe(true);
    expect(row.disposition).toBe('keep');

    const stats = await sweepRetention(Date.parse('2026-08-20'));
    expect(stats.trashed).toBe(0); // never re-trashed
  });

  it('purges swept trash after the grace window, leaves user-trashed mail alone', async () => {
    const swept = await ingest(acct, inbox, rawEmail({ from: 'deals@ozbargain.com.au', to: 'alice@demo.test', subject: 'Purge me', date: 'Mon, 01 Jun 2026 10:00:00 +0000' }));
    await processPending();
    await setUserSetting(userId, 'dry_run', 'false');
    await sweepRetention(Date.parse('2026-07-10'));

    // 31 days later: purged
    const stats = await sweepRetention(Date.parse('2026-08-11'));
    expect(stats.purged).toBe(1);
    expect(await one('SELECT 1 FROM messages WHERE id = ?', [swept!.rowId])).toBeUndefined();
  });

  it('label retention edit recomputes dispositions', async () => {
    const m = await ingest(acct, inbox, rawEmail({ from: 'deals@ozbargain.com.au', to: 'alice@demo.test', subject: 'Deal' }));
    await processPending();
    await run('UPDATE labels SET retention_days = NULL, protected = true WHERE id = ?', [saleLabel]);
    await recomputeDisposition(m!.rowId);
    const row = await one<any>('SELECT disposition, delete_at FROM messages WHERE id = ?', [m!.rowId]);
    expect(row.disposition).toBe('keep');
    expect(row.delete_at).toBe(null);
  });
});
