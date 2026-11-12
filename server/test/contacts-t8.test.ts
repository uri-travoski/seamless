import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseAddressList, editDistance } from '@seamless/shared';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest, rawEmail, TEST_USER } from './helpers.ts';

const sent: any[] = [];
vi.mock('nodemailer', async (orig) => {
  const real = await orig<any>();
  return { default: { ...real.default, createTransport: () => ({ sendMail: async (m: any) => { sent.push(m); return { messageId: 'ok' }; }, verify: async () => true }) } };
});

const { q, one, run } = await import('../src/db.ts');
const { sendEmail } = await import('../src/mail/send.ts');
const { harvestContacts, autoSaveAfterSend } = await import('../src/contacts.ts');
const { setStoredMode } = await import('../src/mode.ts');
const { serializeContacts, parseContactFile, decodeText } = await import('../src/addressbook/formats.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');

let app: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;
let acct: number; let inbox: number; let sentBox: number;

const api = (method: any, url: string, body?: any, ck = cookie) => app.inject({ method, url, payload: body, headers: { cookie: ck } });
function upload(url: string, data: Buffer, ck = cookie) {
  const b = '----x';
  const payload = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="c.csv"\r\nContent-Type: application/octet-stream\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`)]);
  return app.inject({ method: 'POST', url, payload, headers: { cookie: ck, 'content-type': `multipart/form-data; boundary=${b}` } });
}
const payload = (over: any = {}) => ({
  accountId: acct, fromEmail: 'alice@demo.test', to: [{ name: 'Bob Builder', email: 'bob@client.test' }], cc: [], bcc: [],
  subject: 'Hi', html: '<p>hi</p>', attachmentIds: [], track: false, ...over,
});
const contacts = async (uid = TEST_USER) => q<any>(`SELECT c.*, (SELECT string_agg(email, ',') FROM contact_emails WHERE contact_id = c.id) AS emails FROM contacts c WHERE c.user_id = ? ORDER BY c.id`, [uid]);

beforeEach(async () => {
  await resetDb(); resetLimiters(); sent.length = 0;
  await setStoredMode('live');
  acct = await makeAccount('alice@demo.test', { aliases: ['info@demo.test'], name: 'Alice' });
  inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  sentBox = await makeMailbox(acct, 'Sent', 'sent');
  app = await makeApp(); cookie = await login(app);
});

describe('instant auto-save', () => {
  it('sending to a new address creates exactly one contact at once, a second send only counts', async () => {
    await sendEmail(TEST_USER, payload());
    let cs = await contacts();
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ display_name: 'Bob Builder', emails: 'bob@client.test', sent_count: 1, auto_created: true });
    await sendEmail(TEST_USER, payload());
    cs = await contacts();
    expect(cs).toHaveLength(1);
    expect(cs[0].sent_count).toBe(2);
    // the batch safety net must not count the same mail again
    await harvestContacts();
    expect((await contacts())[0].sent_count).toBe(2);
  });

  it('saves Cc and Bcc too; never own addresses, identities or no-reply', async () => {
    await sendEmail(TEST_USER, payload({
      to: [{ name: '', email: 'noreply@shop.test' }, { name: '', email: 'info@demo.test' }],
      cc: [{ name: 'Cy', email: 'cy@x.test' }], bcc: [{ name: '', email: 'bcc@x.test' }, { name: '', email: 'Do-Not-Reply@x.test' }],
    }));
    expect((await contacts()).map((c) => c.emails).sort()).toEqual(['bcc@x.test', 'cy@x.test']);
  });

  it('a reply saves the original sender; sub-option off or list mail does not', async () => {
    const r = await ingest(acct, inbox, rawEmail({ from: 'Jane Doe <jane@client.test>', to: 'alice@demo.test', subject: 'Q', messageId: '<q@c>' }));
    await sendEmail(TEST_USER, payload({ to: [{ name: 'Other', email: 'other@x.test' }], replyToEmailId: `m${r!.rowId}` }));
    expect((await contacts()).map((c) => c.emails).sort()).toEqual(['jane@client.test', 'other@x.test']);
    expect((await contacts()).find((c) => c.emails === 'jane@client.test')).toMatchObject({ received_count: 1, display_name: 'Jane Doe' });

    await run('DELETE FROM contacts');
    await api('PUT', '/api/contacts/settings', { saveRepliers: false });
    await sendEmail(TEST_USER, payload({ to: [{ name: 'Jane Doe', email: 'jane@client.test' }], replyToEmailId: `m${r!.rowId}` }));
    expect(await contacts()).toHaveLength(0);
    await api('PUT', '/api/contacts/settings', { saveRepliers: true });

    const l = await ingest(acct, inbox, rawEmail({ from: 'News <news@list.test>', to: 'alice@demo.test', subject: 'Digest', messageId: '<l@c>' }));
    await run('UPDATE messages SET list_unsubscribe = ? WHERE id = ?', ['<mailto:u@list.test>', l!.rowId]);
    await sendEmail(TEST_USER, payload({ to: [{ name: 'Other', email: 'other@x.test' }], replyToEmailId: `m${l!.rowId}` }));
    expect((await contacts()).map((c) => c.emails)).toEqual(['other@x.test']);
  });

  it('switched off: nothing is saved by send, reply or harvest; old contacts stay', async () => {
    await sendEmail(TEST_USER, payload());
    expect(await contacts()).toHaveLength(1);
    expect((await api('PUT', '/api/contacts/settings', { autoSave: false })).json().autoSave).toBe(false);
    const r = await ingest(acct, inbox, rawEmail({ from: 'Jane <jane@client.test>', to: 'alice@demo.test', subject: 'Q', messageId: '<q@c>' }));
    await sendEmail(TEST_USER, payload({ to: [{ name: 'New', email: 'new@x.test' }], replyToEmailId: `m${r!.rowId}` }));
    await ingest(acct, sentBox, rawEmail({ from: 'alice@demo.test', to: 'laptop@x.test', subject: 'From phone', messageId: '<p@d>' }));
    await harvestContacts();
    expect((await contacts()).map((c) => c.emails)).toEqual(['bob@client.test']);
  });

  it('mail sent from another client is picked up by the batch safety net', async () => {
    await ingest(acct, sentBox, rawEmail({ from: 'alice@demo.test', to: '"Phone Person" <ph@x.test>', subject: 'From phone', messageId: '<p@d>' }));
    await harvestContacts();
    expect((await contacts())[0]).toMatchObject({ emails: 'ph@x.test', display_name: 'Phone Person' });
  });

  it('Viewing mode never saves', async () => {
    await setStoredMode('viewing');
    const out = await autoSaveAfterSend(TEST_USER, [{ name: 'X', email: 'x@x.test' }], Date.now(), null);
    expect(out).toEqual([]);
    await ingest(acct, sentBox, rawEmail({ from: 'alice@demo.test', to: 'v@x.test', subject: 'v', messageId: '<v@d>' }));
    expect(await harvestContacts()).toBe(0);
    expect(await contacts()).toHaveLength(0);
  });

  it('undo removes only the auto-created contact and it is not re-added', async () => {
    await sendEmail(TEST_USER, payload());
    const auto = (await contacts())[0];
    const mine = (await api('POST', '/api/contacts', { displayName: 'Mine', emails: ['mine@x.test'] })).json().id;
    expect((await api('POST', `/api/contacts/${mine}/undo-save`)).json().removed).toBe(false);
    expect(await contacts()).toHaveLength(2);
    expect((await api('POST', `/api/contacts/${auto.id}/undo-save`)).json().removed).toBe(true);
    expect((await contacts()).map((c) => c.emails)).toEqual(['mine@x.test']);
    await sendEmail(TEST_USER, payload());
    await harvestContacts();
    expect((await contacts()).map((c) => c.emails)).toEqual(['mine@x.test']);
  });
});

describe('autocomplete', () => {
  beforeEach(async () => {
    const add = async (b: any) => (await api('POST', '/api/contacts', b)).json().id as number;
    const a = await add({ displayName: 'Maria Gonzalez', org: 'Swan Plumbing', emails: ['maria@swan.test'] });
    const b = await add({ displayName: 'Mark Smith', emails: ['mark@acme.test', 'm.smith@home.test'] });
    await run('UPDATE contacts SET sent_count = 40, last_interaction_at = ? WHERE id = ?', [Date.now() - 86_400_000, b]);
    await run('UPDATE contacts SET sent_count = 2, last_interaction_at = ? WHERE id = ?', [Date.now() - 400 * 86_400_000, a]);
  });

  it('matches name words, email and organisation; ranks by frequency × recency', async () => {
    const byName = (await api('GET', '/api/contacts/suggest?q=smith mark')).json();
    expect(byName[0]).toMatchObject({ type: 'contact', name: 'Mark Smith' });
    const byOrg = (await api('GET', '/api/contacts/suggest?q=plumb')).json();
    expect(byOrg[0]).toMatchObject({ name: 'Maria Gonzalez', email: 'maria@swan.test', org: 'Swan Plumbing' });
    const byMail = (await api('GET', '/api/contacts/suggest?q=acme')).json();
    expect(byMail.map((s: any) => s.email)).toContain('mark@acme.test');
    const ma = (await api('GET', '/api/contacts/suggest?q=ma')).json();
    expect(ma[0].name).toBe('Mark Smith'); // used far more and more recently than Maria
  });

  it('"other contacts" (auto-saved) only appear while auto-save is on', async () => {
    await sendEmail(TEST_USER, payload({ to: [{ name: 'Bob Builder', email: 'bob@client.test' }] }));
    const on = (await api('GET', '/api/contacts/suggest?q=builder')).json();
    expect(on[0]).toMatchObject({ email: 'bob@client.test', other: true });
    await api('PUT', '/api/contacts/settings', { autoSave: false });
    expect((await api('GET', '/api/contacts/suggest?q=builder')).json()).toEqual([]);
    expect((await api('GET', '/api/contacts/suggest?q=mark')).json().length).toBeGreaterThan(0);
  });

  it('parses pasted lists, including quoted commas', () => {
    expect(parseAddressList('Name <a@b.test>, c@d.test; "Doe, Jane" <j@x.test>\nEve <e@x.test>')).toEqual([
      { name: 'Name', email: 'a@b.test' }, { name: '', email: 'c@d.test' }, { name: 'Doe, Jane', email: 'j@x.test' }, { name: 'Eve', email: 'e@x.test' }]);
  });

  it('typo guard: a new address with a known name, or one letter off a known address, is flagged', async () => {
    const same = (await api('GET', '/api/contacts/check?email=mark.s@other.test&name=Mark Smith')).json();
    expect(same.warning).toMatchObject({ reason: 'name', email: 'mark@acme.test' });
    const close = (await api('GET', '/api/contacts/check?email=mark@acne.test')).json();
    expect(close.warning).toMatchObject({ reason: 'similar', email: 'mark@acme.test' });
    expect((await api('GET', '/api/contacts/check?email=mark@acme.test')).json()).toEqual({ known: true });
    expect((await api('GET', '/api/contacts/check?email=zzzzzz@nowhere.example')).json().warning).toBeUndefined();
    expect(editDistance('abc', 'abd')).toBe(1);
  });
});

describe('manage', () => {
  it('add contact with several emails and phones; refuses an address that belongs to another contact', async () => {
    const r = await api('POST', '/api/contacts', { displayName: 'Ann Lee', org: 'Lee Co', notes: 'n', emails: [{ email: 'ann@lee.test', label: 'work' }, { email: 'ann@home.test', label: 'home' }], phones: [{ label: 'mobile', value: '0400 111 222' }] });
    expect(r.statusCode).toBe(200);
    const list = (await api('GET', '/api/contacts')).json();
    expect(list[0]).toMatchObject({ displayName: 'Ann Lee', emails: ['ann@lee.test', 'ann@home.test'], phones: [{ label: 'mobile', value: '0400 111 222' }], autoCreated: false });
    const dup = await api('POST', '/api/contacts', { displayName: 'Other', emails: ['ANN@home.test'] });
    expect(dup.statusCode).toBe(409);
    expect((await api('POST', '/api/contacts', { displayName: 'Bad', emails: ['nope'] })).statusCode).toBe(400);
    // editing emails only touches what is sent
    await api('PUT', `/api/contacts/${r.json().id}`, { emails: ['ann@lee.test'] });
    expect((await api('GET', '/api/contacts')).json()[0]).toMatchObject({ displayName: 'Ann Lee', emails: ['ann@lee.test'] });
  });

  it('merge keeps all emails, phones, groups and adds the counts', async () => {
    const g = (await api('POST', '/api/contact-groups', { name: 'Clients' })).json().id;
    const a = (await api('POST', '/api/contacts', { displayName: 'Sam Roe', emails: ['sam@a.test'], phones: [{ label: 'work', value: '111' }] })).json().id;
    const b = (await api('POST', '/api/contacts', { displayName: 'Sam Roe', emails: ['sam@b.test'], phones: [{ label: 'home', value: '222' }], groupIds: [g], notes: 'vip' })).json().id;
    await run('UPDATE contacts SET sent_count = 3 WHERE id = ?', [a]);
    await run('UPDATE contacts SET sent_count = 4, received_count = 1 WHERE id = ?', [b]);
    const dups = (await api('GET', '/api/contacts/duplicates')).json();
    expect(dups).toHaveLength(1);
    expect(dups[0].reason).toBe('name');
    expect((await api('POST', '/api/contacts/merge', { keepId: a, mergeId: b })).statusCode).toBe(200);
    const list = (await api('GET', '/api/contacts')).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ emails: ['sam@a.test', 'sam@b.test'], sentCount: 7, receivedCount: 1, groupIds: [g], notes: 'vip' });
    expect(list[0].phones.map((p: any) => p.value).sort()).toEqual(['111', '222']);
  });

  it('filters, sort, bulk actions, promote and delete all auto-saved', async () => {
    await sendEmail(TEST_USER, payload({ to: [{ name: 'Auto One', email: 'auto1@x.test' }, { name: 'Auto Two', email: 'auto2@x.test' }] }));
    const mine = (await api('POST', '/api/contacts', { displayName: 'Zed Mine', org: 'Zed Ltd', emails: ['zed@x.test'] })).json().id;
    const get = async (qs: string) => (await api('GET', `/api/contacts?${qs}`)).json().map((c: any) => c.displayName);
    expect(await get('filter=auto&sort=name')).toEqual(['Auto One', 'Auto Two']);
    expect(await get('filter=mine')).toEqual(['Zed Mine']);
    expect(await get('filter=business')).toEqual(['Zed Mine']);
    const ids = (await api('GET', '/api/contacts?filter=auto&sort=name')).json().map((c: any) => c.id);
    await api('POST', '/api/contacts/bulk', { ids: [ids[0]], action: 'hide' });
    expect(await get('filter=hidden')).toEqual(['Auto One']);
    expect(await get('')).not.toContain('Auto One');
    const g = (await api('POST', '/api/contact-groups', { name: 'Team' })).json().id;
    await api('POST', '/api/contacts/bulk', { ids: [mine, ids[1]], action: 'addToGroup', groupId: g });
    expect(await get(`group=${g}&sort=name`)).toEqual(['Auto Two', 'Zed Mine']);
    expect((await api('GET', '/api/contact-groups')).json()).toEqual([{ id: g, name: 'Team', memberCount: 2 }]);
    await api('POST', `/api/contacts/${ids[1]}/promote`);
    expect(await get('filter=mine&sort=name')).toEqual(['Auto Two', 'Zed Mine']);
    expect((await api('DELETE', '/api/contacts?autoSaved=1')).statusCode).toBe(400);
    expect((await api('DELETE', '/api/contacts?autoSaved=1&confirm=1')).json().deleted).toBe(1); // only Auto One is still auto-saved
    expect(await get('filter=all&sort=name')).toEqual(['Auto Two', 'Zed Mine']);
  });

  it('a group name in the To field expands to its members', async () => {
    const g = (await api('POST', '/api/contact-groups', { name: 'Book club' })).json().id;
    const ids: number[] = [];
    for (const [n, e] of [['Ann', 'ann@x.test'], ['Ben', 'ben@x.test']]) ids.push((await api('POST', '/api/contacts', { displayName: n, emails: [e], groupIds: [g] })).json().id);
    await api('POST', '/api/contacts', { displayName: 'Hidden', emails: ['h@x.test'], groupIds: [g], hidden: true });
    const s = (await api('GET', '/api/contacts/suggest?q=book')).json();
    expect(s[0]).toMatchObject({ type: 'group', name: 'Book club', members: [{ name: 'Ann', email: 'ann@x.test' }, { name: 'Ben', email: 'ben@x.test' }] });
    expect((await api('POST', '/api/contact-groups', { name: 'book CLUB' })).statusCode).toBe(409);
  });

  it('detail lists recent conversations; lookup and add-sender', async () => {
    const id = (await api('POST', '/api/contacts', { displayName: 'Jane', emails: ['jane@client.test'] })).json().id;
    await ingest(acct, inbox, rawEmail({ from: 'Jane <jane@client.test>', to: 'alice@demo.test', subject: 'Hello there', messageId: '<h@c>' }));
    const d = (await api('GET', `/api/contacts/${id}/detail`)).json();
    expect(d.conversations.map((c: any) => c.subject)).toEqual(['Hello there']);
    expect((await api('GET', '/api/contacts/lookup?email=nobody@x.test')).json().contact).toBeNull();
    const add = await api('POST', '/api/contacts/add-sender', { email: 'new@x.test', name: 'New Person' });
    expect(add.statusCode).toBe(200);
    expect((await api('GET', '/api/contacts/lookup?email=new@x.test')).json().contact).toMatchObject({ displayName: 'New Person', autoCreated: false });
  });
});

describe('isolation', () => {
  it("user B cannot see or change user A's contacts, groups or settings", async () => {
    const g = (await api('POST', '/api/contact-groups', { name: 'Secret' })).json().id;
    const id = (await api('POST', '/api/contacts', { displayName: 'Alice Friend', emails: ['friend@a.test'], groupIds: [g] })).json().id;
    await makeUser('bob@local');
    const bob = await login(app, 'bob@local');
    expect((await api('GET', '/api/contacts?filter=all', undefined, bob)).json()).toEqual([]);
    expect((await api('GET', '/api/contacts/suggest?q=friend', undefined, bob)).json()).toEqual([]);
    expect((await api('GET', '/api/contact-groups', undefined, bob)).json()).toEqual([]);
    expect((await api('PUT', `/api/contacts/${id}`, { displayName: 'Hacked' }, bob)).statusCode).toBe(404);
    await api('DELETE', `/api/contacts/${id}`, undefined, bob);
    await api('POST', '/api/contacts/bulk', { ids: [id], action: 'delete' }, bob);
    await api('DELETE', `/api/contact-groups/${g}`, undefined, bob);
    expect((await api('POST', '/api/contacts/merge', { keepId: id, mergeId: id + 1 }, bob)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await api('GET', `/api/contacts/${id}/detail`, undefined, bob)).statusCode).toBe(404);
    expect((await api('GET', '/api/contacts/export?format=csv', undefined, bob)).body).not.toContain('friend@a.test');
    // same address is a separate contact for B
    expect((await api('POST', '/api/contacts', { displayName: 'B copy', emails: ['friend@a.test'] }, bob)).statusCode).toBe(200);
    // B's auto-save switch is independent
    await api('PUT', '/api/contacts/settings', { autoSave: false }, bob);
    expect((await api('GET', '/api/contacts/settings')).json().autoSave).toBe(true);
    const a = (await api('GET', '/api/contacts')).json();
    expect(a).toHaveLength(1);
    expect(a[0].displayName).toBe('Alice Friend');
    expect((await api('GET', '/api/contact-groups')).json()).toHaveLength(1);
    // B's "delete all auto-saved" leaves A alone
    await run('UPDATE contacts SET auto_created = true');
    await api('DELETE', '/api/contacts?autoSaved=1&confirm=1', undefined, bob);
    expect(await contacts(TEST_USER)).toHaveLength(1);
  });
});

// ---------------- import / export ----------------
const sample = [
  { displayName: 'Jane Doe', org: 'Doe & Co, Ltd', notes: 'Line one\nLine "two"; ok', emails: [{ email: 'jane@doe.test', label: 'work' }, { email: 'jane@home.test', label: 'home' }], phones: [{ label: 'mobile', value: '+61 400 111 222' }, { label: 'work', value: '08 9000 1111' }], groups: ['Clients', 'Perth'] },
  { displayName: 'Åsa Öberg', org: '', notes: '', emails: [{ email: 'asa@example.se', label: '' }], phones: [], groups: [] },
  { displayName: 'Mary Ann Smith', org: 'Smith', notes: 'ünïcode ✓', emails: [{ email: 'mary@smith.test', label: 'other' }], phones: [{ label: 'home', value: '123' }], groups: ['Clients'] },
];
const norm = (cs: any[]) => cs.map((c) => ({ ...c, emails: c.emails.map((e: any) => e.email).sort(), phones: c.phones.map((p: any) => p.value).sort(), groups: [...c.groups].sort() })).sort((a, b) => a.displayName.localeCompare(b.displayName));

describe('import / export formats', () => {
  for (const fmt of ['vcf', 'google', 'outlook', 'csv', 'json'] as const) {
    it(`round trip ${fmt}: export, then import into an empty user gives the same contacts`, async () => {
      // seed user A through the importer from a JSON file
      const seed = Buffer.from(serializeContacts(sample, 'json').body);
      expect((await upload('/api/contacts/import?mode=merge', seed)).json().created).toBe(3);
      const out = await api('GET', `/api/contacts/export?format=${fmt}`);
      expect(out.statusCode).toBe(200);
      const bobId = await makeUser(`bob-${fmt}@local`);
      const bob = await login(app, `bob-${fmt}@local`);
      const res = (await upload('/api/contacts/import?mode=skip', Buffer.from(out.body), bob)).json();
      expect(res).toMatchObject({ created: 3, invalid: 0 });
      const back = (await api('GET', '/api/contacts?filter=all', undefined, bob)).json();
      const groups = (await api('GET', '/api/contact-groups', undefined, bob)).json();
      const asContacts = back.map((c: any) => ({
        displayName: c.displayName, org: c.org, notes: c.notes, emails: c.emailsDetail, phones: c.phones,
        groups: c.groupIds.map((id: number) => groups.find((g: any) => g.id === id).name),
      }));
      const expected = fmt === 'csv' ? sample.map((c) => ({ ...c, phones: c.phones.map((p) => ({ ...p })) })) : sample;
      expect(norm(asContacts).map((c) => ({ ...c, phones: c.phones }))).toEqual(norm(expected).map((c) => ({ ...c })));
      expect(bobId).toBeGreaterThan(0);
    });
  }

  it('detects UTF-16 and ; separated Google/Outlook-style files; fixtures with real headers', () => {
    const google = 'Name,Given Name,Additional Name,Family Name,Yomi Name,Notes,Group Membership,E-mail 1 - Type,E-mail 1 - Value,E-mail 2 - Type,E-mail 2 - Value,Phone 1 - Type,Phone 1 - Value,Organization 1 - Name\r\n' +
      'Pat Lee,Pat,,Lee,,Hi,* myContacts ::: Friends,* Work,pat@lee.test,Home,pat2@lee.test,Mobile,0411,Lee Inc\r\n';
    const g = parseContactFile(Buffer.from(google));
    expect(g.flavor).toBe('google');
    expect(g.contacts[0]).toMatchObject({ displayName: 'Pat Lee', org: 'Lee Inc', groups: ['Friends'], emails: [{ email: 'pat@lee.test', label: 'work' }, { email: 'pat2@lee.test', label: 'home' }], phones: [{ label: 'mobile', value: '0411' }] });

    const outlook = 'First Name;Middle Name;Last Name;Company;E-mail Address;E-mail 2 Address;Mobile Phone;Business Phone;Notes;Categories\r\nOli;;Vander;Vander AG;oli@v.test;;0499;;n;"Work;Team"\r\n';
    const o = parseContactFile(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(outlook, 'utf16le')]));
    expect(o.flavor).toBe('outlook');
    expect(o.contacts[0]).toMatchObject({ displayName: 'Oli Vander', org: 'Vander AG', emails: [{ email: 'oli@v.test' }], phones: [{ label: 'mobile', value: '0499' }], groups: ['Work', 'Team'] });

    const apple = 'First Name,Last Name,Display Name,Primary Email,Secondary Email,Work Phone,Organization\nAl,Pine,Al Pine,al@p.test,al2@p.test,555,Pine\n';
    const a = parseContactFile(Buffer.from(apple));
    expect(a.flavor).toBe('apple');
    expect(a.contacts[0]).toMatchObject({ displayName: 'Al Pine', org: 'Pine', emails: [{ email: 'al@p.test' }, { email: 'al2@p.test' }], phones: [{ label: 'work', value: '555' }] });
    expect(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x41]))).toBe('A');
  });

  it('reads vCard 2.1, 3.0 and 4.0 (several cards, photos ignored)', () => {
    const v = [
      'BEGIN:VCARD\r\nVERSION:2.1\r\nN:Doe;John;;;\r\nTEL;CELL:0400\r\nEMAIL;WORK:j@d.test\r\nPHOTO;ENCODING=BASE64;JPEG:AAAA\r\n BBBB\r\nEND:VCARD',
      'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Kay Lo\r\nitem1.EMAIL;type=INTERNET;type=HOME:kay@l.test\r\nCATEGORIES:A,B\r\nNOTE:a\\, b\\nc\r\nEND:VCARD',
      'BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Lee Wu\r\nORG:Wu Ltd;Sales\r\nEMAIL;TYPE=work:lee@w.test\r\nTEL;VALUE=uri;TYPE="cell,voice":tel:+6140\r\nEND:VCARD',
    ].join('\r\n');
    const r = parseContactFile(Buffer.from(v)).contacts as any[];
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ displayName: 'John Doe', emails: [{ email: 'j@d.test', label: 'work' }], phones: [{ label: 'mobile', value: '0400' }] });
    expect(r[1]).toMatchObject({ displayName: 'Kay Lo', emails: [{ label: 'home' }], groups: ['A', 'B'], notes: 'a, b\nc' });
    expect(r[2]).toMatchObject({ org: 'Wu Ltd', phones: [{ label: 'mobile', value: '+6140' }] });
  });

  it('CSV preview counts new/duplicate/invalid, then import honours skip / merge / fill', async () => {
    await api('POST', '/api/contacts', { displayName: 'Existing', emails: ['ex@x.test'] });
    const csv = 'Name,Email,Phone,Company,Groups\nExisting Person,ex@x.test,0400,Acme,VIP\nNew One,new@x.test,,,VIP\nBroken,not-an-email,,,\nNoMail,,,,\nRepeat,new@x.test,,,\n';
    const prev = (await upload('/api/contacts/import?preview=1&mode=skip', Buffer.from(csv))).json();
    expect(prev).toMatchObject({ preview: true, total: 5, created: 1, duplicates: 2, invalid: 2, groupsCreated: ['VIP'] });
    expect(await contacts()).toHaveLength(1);              // preview wrote nothing
    expect((await api('GET', '/api/contact-groups')).json()).toEqual([]);

    const skip = (await upload('/api/contacts/import?mode=skip', Buffer.from(csv))).json();
    expect(skip).toMatchObject({ created: 1, skipped: 4 });
    expect(skip.skippedRows.map((r: any) => r.reason).sort()).toEqual(['duplicate', 'duplicate', 'invalid email address', 'no email address']);
    expect((await api('GET', '/api/contacts?filter=all&sort=name')).json().find((c: any) => c.displayName === 'Existing').phones).toEqual([]);

    const fill = (await upload('/api/contacts/import?mode=fill', Buffer.from(csv))).json();
    expect(fill.merged).toBeGreaterThan(0);
    const ex1 = (await api('GET', '/api/contacts?filter=all')).json().find((c: any) => c.emails.includes('ex@x.test'));
    expect(ex1).toMatchObject({ displayName: 'Existing', org: 'Acme', phones: [] }); // empty org filled; name kept; lists untouched

    await upload('/api/contacts/import?mode=merge', Buffer.from(csv));
    const ex2 = (await api('GET', '/api/contacts?filter=all')).json().find((c: any) => c.emails.includes('ex@x.test'));
    expect(ex2.phones).toEqual([{ label: 'other', value: '0400' }]);
    expect(ex2.groupIds).toHaveLength(1);
    expect(await contacts()).toHaveLength(2);
  });

  it('generic CSV with a column mapping; malformed rows are reported, not fatal', async () => {
    const csv = 'Full;Mail 1;Mail 2;Tel\nAnn;ann@x.test;ann2@x.test;111\n"Unclosed;x\n';
    const prev = (await upload('/api/contacts/import?preview=1', Buffer.from(csv))).json();
    expect(prev.flavor).toBe('generic');
    expect(prev.mapping.email).toBeUndefined();
    const mapping = JSON.stringify({ name: ['Full'], email: ['Mail 1', 'Mail 2'], phone: ['Tel'] });
    const res = (await upload(`/api/contacts/import?mapping=${encodeURIComponent(mapping)}`, Buffer.from(csv))).json();
    expect(res.created).toBe(1);
    expect((await api('GET', '/api/contacts')).json()[0]).toMatchObject({ displayName: 'Ann', emails: ['ann@x.test', 'ann2@x.test'] });
  });

  it('export of selected ids / a group / a filter', async () => {
    const g = (await api('POST', '/api/contact-groups', { name: 'G' })).json().id;
    const a = (await api('POST', '/api/contacts', { displayName: 'Aa', emails: ['aa@x.test'], groupIds: [g] })).json().id;
    await api('POST', '/api/contacts', { displayName: 'Bb', emails: ['bb@x.test'] });
    expect((await api('GET', `/api/contacts/export?format=csv&ids=${a}`)).body).not.toContain('bb@x.test');
    expect((await api('GET', `/api/contacts/export?format=vcf&group=${g}`)).body).toContain('CATEGORIES:G');
    expect((await api('GET', '/api/contacts/export?format=outlook&filter=mine')).body).toContain('E-mail 2 Address');
    expect((await api('GET', '/api/contacts/export?format=xml')).statusCode).toBe(400);
    expect((await api('GET', '/api/contacts/export.vcf')).headers['content-disposition']).toContain('.vcf');
  });
});
