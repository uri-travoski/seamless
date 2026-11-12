/** T6.2 F-41: attachment content search. */
import { describe, it, expect, beforeEach } from 'vitest';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest } from './helpers.ts';

const { q, one } = await import('../src/db.ts');
const { runDueJobs } = await import('../src/jobs/runner.ts');
const { queryEmails } = await import('../src/mail/store.ts');
const { parseSearch } = await import('../src/mail/searchparse.ts');
const { extractText, indexMessageAttachments, startBackfill, runBackfillBatch, backfillStatus, BACKFILL_BATCH } = await import('../src/mail/attachmentText.ts');
const { getUserSetting } = await import('../src/classify/settings.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');

function pdfWith(text: string): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 14 Tf 10 50 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n'; const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out);
}
async function docxWith(text: string): Promise<Buffer> {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return z.generateAsync({ type: 'nodebuffer' });
}
async function xlsxWith(text: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['item', text, 42]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
async function pptxWith(text: string): Promise<Buffer> {
  const z = new JSZip();
  z.file('ppt/slides/slide1.xml', `<p:sld xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`);
  return z.generateAsync({ type: 'nodebuffer' });
}

async function mail(atts: { filename: string; content: Buffer; contentType?: string }[], subject = 'Files', body = 'see attached') {
  return Buffer.from(await new MailComposer({
    from: 'x@y.test', to: 'a@demo.test', subject, text: body,
    date: new Date('2026-06-01T10:00:00Z'), attachments: atts,
  }).compile().build());
}

let A: number, B: number, acct: number, inbox: number, acctB: number, inboxB: number;
const ids = async (u: number, text: string) => (await queryEmails(u, { filter: { text, scope: 'unified' }, position: 0, limit: 50 }));

beforeEach(async () => {
  await resetDb(); resetLimiters();
  A = await makeUser('a@x.test'); B = await makeUser('b@x.test');
  acct = await makeAccount('a@demo.test', { userId: A }); inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  acctB = await makeAccount('b@demo.test', { userId: B }); inboxB = await makeMailbox(acctB, 'INBOX', 'inbox');
});

describe('extraction', () => {
  it('reads PDF, DOCX, XLSX, PPTX, TXT, CSV and HTML', async () => {
    expect(await extractText(pdfWith('zebrapdf word'), 'a.pdf', 'application/pdf')).toContain('zebrapdf');
    expect(await extractText(await docxWith('zebradocx word'), 'a.docx', '')).toContain('zebradocx');
    expect(await extractText(await xlsxWith('zebraxlsx'), 'a.xlsx', '')).toContain('zebraxlsx');
    expect(await extractText(await pptxWith('zebrapptx &amp; co'), 'a.pptx', '')).toContain('zebrapptx & co');
    expect(await extractText(Buffer.from('zebratxt'), 'a.txt', 'text/plain')).toBe('zebratxt');
    expect(await extractText(Buffer.from('a,b\nzebracsv,2'), 'a.csv', 'text/csv')).toContain('zebracsv');
    expect(await extractText(Buffer.from('<p>zebrahtml <b>x</b></p><script>no()</script>'), 'a.html', 'text/html')).toMatch(/zebrahtml/);
  });
  it('skips unknown types, oversize input and corrupt files; caps the stored text', async () => {
    expect(await extractText(Buffer.from('x'), 'a.png', 'image/png')).toBeNull();
    expect(await extractText(Buffer.from('not a pdf'), 'a.pdf', 'application/pdf')).toBeNull();
    expect((await extractText(Buffer.from('word '.repeat(100_000)), 'big.txt', 'text/plain'))!.length).toBeLessThanOrEqual(200 * 1024);
  });
});

describe('indexing + search', () => {
  it('ingest queues a job; running it makes the attachment text searchable with a snippet', async () => {
    const r = await ingest(acct, inbox, await mail([
      { filename: 'invoice-1234.pdf', content: pdfWith('Invoice 1234 for plumbing services') },
      { filename: 'notes.txt', content: Buffer.from('unrelated') },
    ], 'Documents'));
    expect(r).toBeTruthy();
    expect(Number((await one<any>("SELECT COUNT(*) AS c FROM jobs WHERE kind = 'attachments.extract'"))!.c)).toBe(1);
    expect((await ids(A, 'plumbing')).total).toBe(0);            // not indexed yet
    await runDueJobs();
    const res = await ids(A, 'plumbing');
    expect(res.ids).toEqual([`m${r!.rowId}`]);
    expect(res.attachmentMatches![`m${r!.rowId}`].filename).toBe('invoice-1234.pdf');
    expect(res.attachmentMatches![`m${r!.rowId}`].snippet).toMatch(/<<plumbing>>/);
  });

  it('finds every format and ranks body matches before attachment matches', async () => {
    const bodyHit = await ingest(acct, inbox, await mail([], 'Body one', 'the quarterly report is below'));
    const attHit = await ingest(acct, inbox, await mail([{ filename: 'q.docx', content: await docxWith('quarterly numbers') }], 'Att one'));
    await ingest(acct, inbox, await mail([{ filename: 'x.xlsx', content: await xlsxWith('spreadsheetword') }], 'Sheet'));
    await ingest(acct, inbox, await mail([{ filename: 'p.pptx', content: await pptxWith('slideword') }], 'Slides'));
    await runDueJobs();
    expect((await ids(A, 'quarterly')).ids).toEqual([`m${bodyHit!.rowId}`, `m${attHit!.rowId}`]);   // body first even though the attachment mail is not older
    expect((await ids(A, 'spreadsheetword')).total).toBe(1);
    expect((await ids(A, 'slideword')).total).toBe(1);
  });

  it('attachment: and filename: operators', async () => {
    const a = await ingest(acct, inbox, await mail([{ filename: 'quote-77.pdf', content: pdfWith('invoice 1234 total') }], 'One'));
    const b = await ingest(acct, inbox, await mail([{ filename: 'photo.png', content: Buffer.from('x'), contentType: 'image/png' }], 'Two', 'invoice 1234 in body only'));
    await runDueJobs();
    expect(parseSearch('attachment:"invoice 1234"').attachment).toBeTruthy();
    expect((await ids(A, 'attachment:"invoice 1234"')).ids).toEqual([`m${a!.rowId}`]);   // body-only mention excluded
    expect((await ids(A, 'filename:quote*.pdf')).ids).toEqual([`m${a!.rowId}`]);
    expect((await ids(A, 'filename:*.png')).ids).toEqual([`m${b!.rowId}`]);               // works for files that have no extractable text
    expect((await ids(A, 'filename:quote*.docx')).total).toBe(0);
  });

  it('re-indexing is idempotent and cascades with the message', async () => {
    const r = await ingest(acct, inbox, await mail([{ filename: 'a.txt', content: Buffer.from('hello world') }]));
    await indexMessageAttachments(r!.rowId); await indexMessageAttachments(r!.rowId);
    expect((await q('SELECT id FROM attachment_text')).length).toBe(1);
    await q('DELETE FROM messages WHERE id = ?', [r!.rowId]);
    expect((await q('SELECT id FROM attachment_text')).length).toBe(0);
  });

  it('user B cannot find user A\'s attachment text', async () => {
    await ingest(acct, inbox, await mail([{ filename: 'secret.txt', content: Buffer.from('confidentialtoken') }]));
    await ingest(acctB, inboxB, await mail([{ filename: 'mine.txt', content: Buffer.from('othertoken') }]));
    await runDueJobs();
    expect((await ids(A, 'confidentialtoken')).total).toBe(1);
    expect((await ids(B, 'confidentialtoken')).total).toBe(0);
    expect((await ids(B, 'filename:secret*')).total).toBe(0);
    expect((await ids(B, 'othertoken')).total).toBe(1);
  });
});

describe('backfill', () => {
  it('processes 100 messages per run, resumes from its cursor, and reports progress', async () => {
    const n = BACKFILL_BATCH + 5;
    for (let i = 0; i < n; i++) await ingest(acct, inbox, await mail([{ filename: `f${i}.txt`, content: Buffer.from(`needle${String(i).padStart(4, '0')}`) }], `M${i}`));
    await q("DELETE FROM jobs");                       // pretend this is old mail that was never indexed
    expect((await ids(A, 'needle0003')).total).toBe(0);

    await startBackfill(A);
    expect((await backfillStatus(A)).state).toBe('running');
    expect(await runBackfillBatch(A)).toBe(BACKFILL_BATCH);
    expect((await backfillStatus(A)).processed).toBe(BACKFILL_BATCH);
    expect((await ids(A, 'needle0003')).total).toBe(1);
    expect((await ids(A, `needle${String(n - 1).padStart(4, '0')}`)).total).toBe(0);
    const cursor = await getUserSetting(A, 'attach_backfill_cursor');
    expect(Number(cursor)).toBeGreaterThan(0);

    expect(await runBackfillBatch(A)).toBe(5);         // resumed after the cursor, not from the start
    expect((await backfillStatus(A))).toMatchObject({ state: 'done', processed: n, total: n });
    expect((await ids(A, `needle${String(n - 1).padStart(4, '0')}`)).total).toBe(1);
  });

  it('the Health endpoint is admin-only and only touches the caller\'s mail', async () => {
    const app = await makeApp();
    const ckA = await login(app, 'a@x.test'); const ckB = await login(app, 'b@x.test');
    const post = (ck: string) => app.inject({ method: 'POST', url: '/api/health/attachment-index', payload: {}, headers: { cookie: ck } });
    expect((await post(ckA)).statusCode).toBe(403);     // both are members
    await q("UPDATE users SET role = 'admin' WHERE id = ?", [B]);
    const r = await post(ckB);
    expect(r.statusCode).toBe(200);
    expect(r.json().state).toBe('running');
    expect(await getUserSetting(A, 'attach_backfill_state')).toBe('');
  });
});
