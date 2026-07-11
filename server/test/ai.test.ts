import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { resetDb, makeAccount, makeMailbox, ingest, rawEmail, TEST_USER } from './helpers.ts';
import { q, one, run, insertId } from '../src/db.ts';
import { extractJson } from '../src/ai/client.ts';
import { categorizeEmail, summarizeThread } from '../src/ai/tasks.ts';

function mockAiResponse(content: string) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
}

let acct: number, inbox: number, rowId: number, threadId: string, userId: number;

beforeAll(async () => {
  await resetDb();
  userId = TEST_USER;
  acct = await makeAccount('alice@demo.test');
  inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  const r = await ingest(acct, inbox, rawEmail({
    from: 'billing@vendor.test', to: 'alice@demo.test', subject: 'Invoice #1234',
    body: 'Please find attached invoice for June.', messageId: '<inv@vendor>',
  }));
  rowId = r!.rowId;
  threadId = (await one<any>('SELECT thread_id FROM messages WHERE id = ?', [rowId]))!.thread_id;

  const providerId = await insertId(
    "INSERT INTO ai_providers(user_id, name, base_url, api_key_enc, model) VALUES (?, 'stub','http://stub.test/v1','','test-model')", [userId]);
  for (const t of ['categorize', 'summarize', 'draft']) {
    await run('INSERT INTO ai_tasks(user_id, task, provider_id, model, enabled) VALUES (?,?,?,?,true)', [userId, t, providerId, '']);
  }
  await run("INSERT INTO labels(user_id, name, color, description) VALUES (?, 'Finance', '#ff0000', 'Invoices and payments')", [userId]);
});

afterEach(() => vi.unstubAllGlobals());

describe('extractJson', () => {
  it('parses plain, fenced, and prose-wrapped JSON', () => {
    expect(extractJson('{"label":"X"}')).toEqual({ label: 'X' });
    expect(extractJson('```json\n{"label":"X"}\n```')).toEqual({ label: 'X' });
    expect(extractJson('Sure! Here: {"label":"X"} hope that helps')).toEqual({ label: 'X' });
    expect(extractJson('no json at all')).toBe(null);
  });
});

describe('AI tasks', () => {
  it('categorize applies the matching label', async () => {
    mockAiResponse('{"label": "finance"}'); // wrong case on purpose
    const label = await categorizeEmail(userId, rowId);
    expect(label).toBe('Finance');
    const rows = await q('SELECT * FROM message_labels WHERE message_id = ?', [rowId]);
    expect(rows.length).toBe(1);
  });

  it('categorize ignores unknown labels', async () => {
    await run('DELETE FROM message_labels');
    mockAiResponse('{"label": "Nonexistent"}');
    const label = await categorizeEmail(userId, rowId);
    expect(label).toBe(null);
    expect((await one<any>('SELECT COUNT(*) c FROM message_labels'))!.c).toBe(0);
  });

  it('summarize returns provider text', async () => {
    mockAiResponse('- vendor sent June invoice\n- payment pending');
    const summary = await summarizeThread(userId, threadId);
    expect(summary).toContain('June invoice');
  });

  it('summarize fails clearly with no provider', async () => {
    await run("UPDATE ai_tasks SET enabled = false WHERE task = 'summarize'");
    await expect(summarizeThread(userId, threadId)).rejects.toThrow(/No AI provider/);
    await run("UPDATE ai_tasks SET enabled = true WHERE task = 'summarize'");
  });
});
