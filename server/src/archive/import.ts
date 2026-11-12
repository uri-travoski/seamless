/** Open an archive in another instance (T8.6): import an archive's mail into read-only "archived mailboxes" and merge its app data.
 *  Job `archive.import` is resumable and idempotent (mail_archive_imports remembers every message key), can pause, and never
 *  writes to the source. Imported mail goes through the normal non-live ingest path: no AI, no notifications, no filters. */
import { gunzipSync } from 'node:zlib';
import { q, one, run, insertId, bumpState } from '../db.ts';
import { sha256 } from '../crypto.ts';
import { ingestMessage, deleteMessageRow } from '../mail/ingest.ts';
import { deleteBlob } from '../s3.ts';
import { registerJob, enqueueJob } from '../jobs/runner.ts';
import { audit } from '../audit/log.ts';
import { broadcast } from '../ws.ts';
import * as biz from '../business/businesses.ts';
import type { BlobStore } from '../s3.ts';
import { ArchiveError } from './select.ts';
import type { IndexEntry } from './restore.ts';
import { sourceStore, readManifestIn, rebaser, type ImportSourceRef } from './source.ts';
import { SECRET_KEY } from './config.ts';
import { importAiSettings, importAiMessages, hasAiMemory } from './aimemory.ts';
import { groupByName } from '../addressbook/manage.ts';

const BUDGET_MS = 40_000;
const MAX_ATTEMPTS = 5;

export const CATEGORIES = ['labels', 'rules', 'filters', 'views', 'templates', 'contacts', 'businesses', 'senders', 'notes', 'appearance', 'ai'] as const;
export type Category = (typeof CATEGORIES)[number];
export interface ImportOptions { accounts: 'all' | string[]; categories: Record<Category, boolean> }

export interface ImportRow {
  id: number; user_id: number; source_kind: 'bucket' | 'zip' | 'folder'; target_id: number | null; source_ref: string; archive_path: string; name: string;
  status: 'queued' | 'running' | 'paused' | 'done' | 'failed'; options: ImportOptions; summary: any; total: number | null; imported: number; skipped: number; failed: number;
  config_result: any; account_ids: number[]; error: string | null; created_at: string | number; finished_at: string | number | null;
}

export const normalizeOptions = (o: any): ImportOptions => {
  const cats = {} as Record<Category, boolean>;
  for (const c of CATEGORIES) cats[c] = o?.categories?.[c] === undefined ? true : !!o.categories[c];   // all on by default
  const acc = Array.isArray(o?.accounts) ? (o.accounts as unknown[]).map(String) : 'all';
  return { accounts: acc, categories: cats };
};

const srcOf = (r: ImportRow): ImportSourceRef => ({ kind: r.source_kind, targetId: r.target_id, ref: r.source_ref });
const byId = (id: number) => one<ImportRow>('SELECT * FROM archive_imports WHERE id = ?', [id]);
export const getImport = (userId: number, id: number) => one<ImportRow>('SELECT * FROM archive_imports WHERE id = ? AND user_id = ?', [id, userId]);

export function importView(r: ImportRow) {
  const done = r.imported + r.skipped + r.failed;
  return {
    id: r.id, name: r.name, sourceKind: r.source_kind, archivePath: r.archive_path, status: r.status, options: r.options, summary: r.summary,
    total: r.total, imported: r.imported, skipped: r.skipped, failed: r.failed, configResult: r.config_result, error: r.error,
    createdAt: Number(r.created_at), finishedAt: r.finished_at ? Number(r.finished_at) : null,
    progress: r.total ? Math.min(1, done / r.total) : (r.status === 'done' ? 1 : 0),
  };
}

/** Queue one import per archive. Attaching the same archive twice returns the existing import (idempotent). */
export async function queueImport(userId: number, src: ImportSourceRef, dirs: string[], opts: any, names: Record<string, string> = {}): Promise<ImportRow[]> {
  const options = normalizeOptions(opts);
  const store = await sourceStore(src);
  const out: ImportRow[] = [];
  for (const dir of dirs) {
    const m = await readManifestIn(store, dir);             // refuses unknown / newer formats before anything is created
    const known = await one<ImportRow>(
      `SELECT * FROM archive_imports WHERE user_id = ? AND source_kind = ? AND COALESCE(target_id,0) = ? AND source_ref = ? AND archive_path = ?`,
      [userId, src.kind, src.targetId ?? 0, src.ref, dir]);
    if (known) {
      await run("UPDATE archive_imports SET options = ?::jsonb, status = CASE WHEN status IN ('done','failed','paused') THEN 'queued' ELSE status END, finished_at = NULL, total = NULL WHERE id = ?", [JSON.stringify(options), known.id]);
      await enqueueJob(userId, 'archive.import', Date.now(), { importId: known.id });
      out.push((await byId(known.id))!); continue;
    }
    const id = await insertId(
      `INSERT INTO archive_imports(user_id, source_kind, target_id, source_ref, archive_path, name, status, options, summary, created_at)
       VALUES (?,?,?,?,?,?, 'queued', ?::jsonb, ?::jsonb, ?)`,
      [userId, src.kind, src.targetId, src.ref, dir, (names[dir] || m.name || `Archive #${m.archiveId}`).slice(0, 160), JSON.stringify(options),
        JSON.stringify({ archiveId: m.archiveId, appVersion: m.appVersion, messages: m.counts?.messages ?? 0, accounts: m.accounts.map((a) => ({ key: a.key, email: a.email })) }), Date.now()]);
    await enqueueJob(userId, 'archive.import', Date.now(), { importId: id });
    await audit(null, 'archive.import_queued', { type: 'archive_import', id }, { name: m.name, source: src.kind }, { userId });
    out.push((await byId(id))!);
  }
  return out;
}

const mapOf = (rows: { key: string; id: number }[]) => new Map(rows.map((r) => [r.key, r.id]));
const parseJson = (s: unknown, fb: any) => { try { return typeof s === 'string' ? JSON.parse(s) : (s ?? fb); } catch { return fb; } };

/** Archived mailboxes: accounts with archived = true. No IMAP/SMTP, no passwords, never polled. */
async function ensureAccounts(imp: ImportRow, m: any): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const picked = imp.options.accounts;
  const ids: number[] = [];
  for (const a of m.accounts as { key: string; email: string; displayName: string; mailboxes: { path: string; role: string | null }[] }[]) {
    if (picked !== 'all' && !picked.includes(a.key)) continue;
    let row = await one<{ id: number }>('SELECT id FROM accounts WHERE user_id = ? AND archived AND lower(email) = lower(?) ORDER BY id LIMIT 1', [imp.user_id, a.email]);
    if (!row) {
      const id = await insertId(
        `INSERT INTO accounts(user_id, name, email, aliases, imap_host, imap_port, imap_secure, imap_user, imap_pass_enc, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc,
           sent_copy, enabled, inbound_kind, archived, source_archive_id, created_at)
         VALUES (?,?,?, '[]', '', 0, false, '', '', '', 0, false, '', '', false, false, 'none', true, ?, ?)`,
        [imp.user_id, `Archive — ${a.email}`, a.email, imp.id, Date.now()]);
      row = { id };
    }
    map.set(a.key, row.id); ids.push(row.id);
    for (const mb of a.mailboxes) {
      await run(
        `INSERT INTO mailboxes(account_id, path, role, name) VALUES (?,?,?,?)
         ON CONFLICT (account_id, path) DO UPDATE SET role = COALESCE(mailboxes.role, EXCLUDED.role)`, [row.id, mb.path, mb.role, mb.path]);
    }
  }
  await run('UPDATE archive_imports SET account_ids = ?::jsonb WHERE id = ?', [JSON.stringify(ids), imp.id]);
  return map;
}

/** "Archive — name@example.com (2012–2020)" from the dates of the mail that is really in the account. */
async function nameAccounts(accountIds: number[]) {
  for (const id of accountIds) {
    const r = await one<{ lo: string | null; hi: string | null; email: string }>(
      `SELECT MIN(m.date) lo, MAX(m.date) hi, a.email FROM accounts a LEFT JOIN messages m ON m.account_id = a.id WHERE a.id = ? GROUP BY a.email`, [id]);
    if (!r) continue;
    const y = (v: string | null) => (v ? new Date(Number(v)).getUTCFullYear() : null);
    const [lo, hi] = [y(r.lo), y(r.hi)];
    const range = lo == null ? '' : lo === hi ? ` (${lo})` : ` (${lo}–${hi})`;
    await run('UPDATE accounts SET name = ? WHERE id = ?', [`Archive — ${r.email}${range}`, id]);
  }
}

type Counts = { created: number; skipped: number };
const C = (): Counts => ({ created: 0, skipped: 0 });

interface Maps { labels: Map<string, number>; businesses: Map<string, number> }

/** Labels by name: an existing one is kept as it is (skipped), a new one is created with its colour, parent, sidebar and retention. */
async function importLabels(imp: ImportRow, cfg: any, m: any, maps: Maps): Promise<Counts> {
  const res = C();
  const list: any[] = cfg?.labels?.length ? cfg.labels : (m.labels ?? []).map((l: any) => ({ key: l.key, name: l.name, color: l.color, parentKey: l.parentKey }));
  const pending = [...list];
  // parents first: a label whose parent is not mapped yet waits for the next pass
  for (let pass = 0; pass < 8 && pending.length; pass++) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const l = pending[i];
      if (l.parentKey && !maps.labels.has(l.parentKey) && pending.some((p) => p.key === l.parentKey) && pass < 7) continue;
      pending.splice(i, 1);
      const have = await one<{ id: number }>('SELECT id FROM labels WHERE user_id = ? AND name = ?', [imp.user_id, l.name]);
      if (have) { maps.labels.set(l.key, have.id); res.skipped++; continue; }
      const id = await insertId(
        `INSERT INTO labels(user_id, name, color, description, sort, parent_id, sidebar_visibility, keep_default, retention_days, protected, auto_mark_read)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [imp.user_id, l.name, l.color ?? '#e05656', l.description ?? '', l.sort ?? 0, l.parentKey ? (maps.labels.get(l.parentKey) ?? null) : null,
          l.sidebarVisibility ?? 'always', !!l.keepDefault, l.retentionDays ?? null, !!l.protected, !!l.autoMarkRead]);
      maps.labels.set(l.key, id); res.created++;
    }
  }
  return res;
}

/** When labels are not being imported, labels that already exist by name are still mapped (never created). */
async function mapExistingLabels(imp: ImportRow, m: any, maps: Maps) {
  for (const l of m.labels ?? []) {
    const have = await one<{ id: number }>('SELECT id FROM labels WHERE user_id = ? AND name = ?', [imp.user_id, l.name]);
    if (have) maps.labels.set(l.key, have.id);
  }
}

async function importRules(imp: ImportRow, cfg: any, maps: Maps): Promise<Counts> {
  const res = C(); const now = Date.now();
  for (const r of cfg.rules ?? []) {
    const labelId = r.labelKey ? maps.labels.get(r.labelKey) ?? null : null;
    if (r.action === 'label' && !labelId) { res.skipped++; continue; }
    const dup = await one('SELECT 1 FROM rules WHERE user_id = ? AND match_field = ? AND match_value = ? AND action = ? AND label_id IS NOT DISTINCT FROM ?', [imp.user_id, r.matchField, r.matchValue, r.action, labelId]);
    if (dup) { res.skipped++; continue; }
    const ord = ((await one<{ n: number }>('SELECT COALESCE(MAX(ord), 0) + 1 AS n FROM rules WHERE user_id = ?', [imp.user_id]))?.n) ?? 1;
    await run(
      `INSERT INTO rules(user_id, enabled, ord, match_field, match_value, exclude_contains, action, label_id, stop, note, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?, 'imported', ?)`,
      [imp.user_id, !!r.enabled, ord, r.matchField, r.matchValue, r.excludeContains ?? '', r.action, labelId, !!r.stop, r.note ?? '', now]);
    res.created++;
  }
  return res;
}

async function importFilters(imp: ImportRow, cfg: any, maps: Maps): Promise<Counts> {
  const res = C();
  for (const f of cfg.filters ?? []) {
    if (await one('SELECT 1 FROM filters WHERE user_id = ? AND name = ?', [imp.user_id, f.name])) { res.skipped++; continue; }
    const actions: any[] = [];
    for (const a of f.actions ?? []) {
      if (a?.type === 'label') {
        const id = a.labelKey ? maps.labels.get(a.labelKey) : undefined;
        if (id) actions.push({ type: 'label', value: String(id) });       // labels not imported: the action cannot work, drop it
      } else if (a?.type === 'send_to_webhook' || a?.type === 'webhook') { /* connectors do not travel with an archive */ }
      else actions.push(a);
    }
    if (!actions.length) { res.skipped++; continue; }
    await run('INSERT INTO filters(user_id, name, enabled, sort, match, conditions, actions, stop) VALUES (?,?,?,?,?,?,?,?)',
      [imp.user_id, f.name, !!f.enabled, f.sort ?? 0, f.match ?? 'all', JSON.stringify(f.conditions ?? []), JSON.stringify(actions), !!f.stop]);
    res.created++;
  }
  return res;
}

async function importViews(imp: ImportRow, cfg: any): Promise<Counts> {
  const res = C();
  for (const v of cfg.savedViews ?? []) {
    if (await one('SELECT 1 FROM saved_views WHERE user_id = ? AND name = ?', [imp.user_id, v.name])) { res.skipped++; continue; }
    const scope = /^(account|category):/.test(String(v.scope)) ? 'unified' : (v.scope || 'unified');   // ids of another instance mean nothing here
    await run('INSERT INTO saved_views(user_id, name, icon, color, query, scope, sort, pinned, show_count, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [imp.user_id, v.name, v.icon ?? 'magnifying-glass', v.color ?? null, v.query, scope, v.sort ?? 'date_desc', v.pinned !== false, v.showCount !== false, v.order ?? 0]);
    res.created++;
  }
  return res;
}

async function importTemplates(imp: ImportRow, cfg: any): Promise<Counts> {
  const res = C(); const now = Date.now();
  for (const t of cfg.templates ?? []) {
    if (await one('SELECT 1 FROM templates WHERE user_id = ? AND name = ?', [imp.user_id, t.name])) { res.skipped++; continue; }
    const shortcutTaken = t.shortcut && await one("SELECT 1 FROM templates WHERE user_id = ? AND shortcut = ?", [imp.user_id, t.shortcut]);
    await run(
      `INSERT INTO templates(user_id, name, category, subject, body_html, shortcut, kind, pinned, pin_order, send_direct, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [imp.user_id, t.name, t.category ?? '', t.subject ?? '', t.bodyHtml ?? '', shortcutTaken ? null : (t.shortcut || null), t.kind ?? 'reply', !!t.pinned, t.pinOrder ?? 0, !!t.sendDirect, now, now]);
    res.created++;
  }
  return res;
}

async function importContacts(imp: ImportRow, cfg: any): Promise<Counts> {
  const res = C(); const now = Date.now();
  for (const c of cfg.contacts ?? []) {
    const emails: { email: string; primary: boolean; label: string }[] = (c.emails ?? []).map((e: any) => ({ email: String(e.email).toLowerCase(), primary: !!e.primary, label: String(e.label ?? '') }));
    if (!emails.length) { res.skipped++; continue; }
    const have = await one('SELECT 1 FROM contact_emails ce JOIN contacts c ON c.id = ce.contact_id WHERE c.user_id = ? AND lower(ce.email) = ANY(?)', [imp.user_id, emails.map((e) => e.email)]);
    if (have) { res.skipped++; continue; }
    const id = await insertId(
      `INSERT INTO contacts(user_id, display_name, org, notes, auto_created, hidden, phones_json, sent_count, received_count, last_interaction_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [imp.user_id, c.displayName ?? '', c.org ?? '', c.notes ?? '', c.autoCreated !== false, !!c.hidden, JSON.stringify(Array.isArray(c.phones) ? c.phones : []),
        Number(c.sentCount) || 0, Number(c.receivedCount) || 0, c.lastInteractionAt ?? null, now, now]);
    for (const e of emails) await run('INSERT INTO contact_emails(contact_id, email, is_primary, label) VALUES (?,?,?,?) ON CONFLICT DO NOTHING', [id, e.email, e.primary, e.label]);
    for (const g of Array.isArray(c.groups) ? c.groups : []) {
      const gid = await groupByName(imp.user_id, String(g), true);
      if (gid) await run('INSERT INTO contact_group_members(group_id, contact_id) VALUES (?,?) ON CONFLICT DO NOTHING', [gid, id]);
    }
    res.created++;
  }
  return res;
}

async function importBusinesses(imp: ImportRow, cfg: any, maps: Maps, accountMap: Map<string, number>): Promise<Counts> {
  const res = C(); const now = Date.now();
  for (const b of cfg.businesses ?? []) {
    const have = await one<{ id: number }>('SELECT id FROM businesses WHERE user_id = ? AND name = ?', [imp.user_id, b.name]);
    if (have) { maps.businesses.set(b.key, have.id); res.skipped++; continue; }
    const id = await insertId(
      `INSERT INTO businesses(user_id, name, short_name, brand_color, website, phone, abn, address, default_signature_html, disclaimer_html, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [imp.user_id, b.name, b.shortName ?? '', b.brandColor ?? '#2f7ed8', b.website ?? '', b.phone ?? '', b.abn ?? '', b.address ?? '', b.signatureHtml ?? '', b.disclaimerHtml ?? '', now]);
    if (b.logo?.base64) await biz.setLogo(imp.user_id, id, Buffer.from(b.logo.base64, 'base64')).catch(() => {});
    maps.businesses.set(b.key, id); res.created++;
  }
  for (const i of cfg.identities ?? []) {
    let accountId = accountMap.get(i.accountKey);
    if (!accountId) accountId = (await one<{ id: number }>('SELECT id FROM accounts WHERE user_id = ? AND lower(email) = lower(?) ORDER BY archived, id LIMIT 1', [imp.user_id, i.email]))?.id;
    if (!accountId) { res.skipped++; continue; }
    if (await one('SELECT 1 FROM identities WHERE account_id = ? AND lower(email) = lower(?)', [accountId, i.email])) { res.skipped++; continue; }
    await run(
      `INSERT INTO identities(user_id, account_id, business_id, email, display_name, signature_html, reply_to, bcc_self, is_default) VALUES (?,?,?,?,?,?,?,?, false)`,
      [imp.user_id, accountId, i.businessKey ? (maps.businesses.get(i.businessKey) ?? null) : null, i.email, i.displayName ?? i.email, i.signatureHtml ?? null, i.replyTo ?? null, !!i.bccSelf]);
    res.created++;
  }
  return res;
}

async function importSenders(imp: ImportRow, cfg: any): Promise<Counts> {
  const res = C(); const now = Date.now();
  for (const [table, rows] of [['vip_senders', cfg.vipSenders], ['trusted_senders', cfg.trustedSenders]] as const) {
    for (const s of rows ?? []) {
      if (s.kind !== 'address' && s.kind !== 'domain') continue;
      const r = await one<{ id: number }>(`INSERT INTO ${table}(user_id, kind, value, created_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING RETURNING id`, [imp.user_id, s.kind, String(s.value).toLowerCase(), now]);
      if (r) res.created++; else res.skipped++;
    }
  }
  return res;
}

async function importAppearance(imp: ImportRow, cfg: any): Promise<Counts> {
  const res = C();
  for (const s of cfg.appearance?.settings ?? []) {
    if (!s?.key || SECRET_KEY.test(String(s.key))) { res.skipped++; continue; }
    const r = await one<{ key: string }>('INSERT INTO user_settings(user_id, key, value) VALUES (?,?,?) ON CONFLICT DO NOTHING RETURNING key', [imp.user_id, String(s.key), String(s.value)]);
    if (r) res.created++; else res.skipped++;
  }
  return res;
}

async function importNotes(imp: ImportRow, cfg: any): Promise<Counts> {
  const res = C();
  for (const n of cfg.notes ?? []) {
    const row = await one<{ message_id: number | null }>("SELECT message_id FROM mail_archive_imports WHERE import_id = ? AND message_key = ? AND state = 'imported'", [imp.id, n.messageKey]);
    if (!row?.message_id) continue;
    const r = await one<{ email_id: string }>('INSERT INTO notes(user_id, email_id, body, updated_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING RETURNING email_id', [imp.user_id, `m${row.message_id}`, n.body, Number(n.updatedAt) || Date.now()]);
    if (r) res.created++; else res.skipped++;
  }
  return res;
}

async function readConfig(store: BlobStore, rb: (p: string) => string, m: any): Promise<any | null> {
  try {
    const cfg = JSON.parse((await store.get(rb(m.config || 'archive/x/config.json'))).toString('utf8'));
    return cfg?.format === 'seamless-archive-config' ? cfg : null;
  } catch { return null; }
}

async function* readIndexAt(store: BlobStore, rb: (p: string) => string, m: any): AsyncGenerator<IndexEntry> {
  for (const f of m.indexFiles ?? []) {
    const text = gunzipSync(await store.get(rb(f))).toString('utf8');
    for (const line of text.split('\n')) if (line.trim()) yield JSON.parse(line) as IndexEntry;
  }
}

const isMissing = (err: any) => /no blob|NoSuchKey|not found|404/i.test(String(err?.message ?? err));

async function bump(id: number, d: { imported?: number; skipped?: number; failed?: number }) {
  await run('UPDATE archive_imports SET imported = imported + ?, skipped = skipped + ?, failed = failed + ? WHERE id = ?', [d.imported ?? 0, d.skipped ?? 0, d.failed ?? 0, id]);
}

/** One slice of an import. Returns true when finished (done / failed / paused), false when more is left. */
export async function runImportSlice(importId: number, opts: { budgetMs?: number } = {}): Promise<boolean> {
  const t0 = Date.now(); const budget = opts.budgetMs ?? BUDGET_MS;
  let imp = await byId(importId);
  if (!imp || imp.status === 'done' || imp.status === 'failed' || imp.status === 'paused') return true;
  const store = await sourceStore(srcOf(imp));
  const m: any = await readManifestIn(store, imp.archive_path);     // newer format → ArchiveError, no retry
  const rb = rebaser(m, imp.archive_path);
  if (imp.status === 'queued') {
    await run("UPDATE archive_imports SET status = 'running', error = NULL WHERE id = ?", [imp.id]);
    await audit(null, 'archive.import_start', { type: 'archive_import', id: imp.id }, { name: imp.name }, { userId: imp.user_id });
  }
  const accountMap = await ensureAccounts(imp, m);
  const cats = imp.options.categories;
  const cfg = await readConfig(store, rb, m);
  const maps: Maps = { labels: new Map(), businesses: new Map() };

  // app data first (idempotent: matches by name, never overwrites), so labels exist when the mail arrives
  const result: Record<string, Counts> = imp.config_result ?? {};
  const first = imp.config_result == null;
  if (cats.labels) { const r = await importLabels(imp, cfg, m, maps); if (first) result.labels = r; } else await mapExistingLabels(imp, m, maps).catch(() => {});
  if (first) {
    if (cfg) {
      if (cats.rules) result.rules = await importRules(imp, cfg, maps);
      if (cats.filters) result.filters = await importFilters(imp, cfg, maps);
      if (cats.views) result.views = await importViews(imp, cfg);
      if (cats.templates) result.templates = await importTemplates(imp, cfg);
      if (cats.contacts) result.contacts = await importContacts(imp, cfg);
      if (cats.businesses) result.businesses = await importBusinesses(imp, cfg, maps, accountMap);
      if (cats.senders) result.senders = await importSenders(imp, cfg);
      if (cats.appearance) result.appearance = await importAppearance(imp, cfg);
    }
    if (cats.ai && hasAiMemory(m)) result.ai = await importAiSettings(imp.user_id, store, rb, m, maps.labels, { rules: cats.rules });
    await run('UPDATE archive_imports SET config_result = ?::jsonb WHERE id = ?', [JSON.stringify({ ...result, hasConfig: !!cfg }), imp.id]);
  }

  // count what will be imported (once), so the progress bar means something
  if (imp.total == null) {
    let total = 0;
    for await (const e of readIndexAt(store, rb, m)) if (accountMap.has(e.accountKey)) total++;
    await run('UPDATE archive_imports SET total = ? WHERE id = ?', [total, imp.id]);
  }

  const done = new Set((await q<{ message_key: string }>('SELECT message_key FROM mail_archive_imports WHERE import_id = ?', [imp.id])).map((r) => r.message_key));
  const mailboxIds = new Map<string, number>();
  const delta = { imported: 0, skipped: 0, failed: 0 };
  const flush = async () => { if (delta.imported || delta.skipped || delta.failed) { await bump(imp!.id, delta); delta.imported = delta.skipped = delta.failed = 0; } };
  const record = (key: string, state: string, messageId: number | null, error: string | null = null) =>
    run('INSERT INTO mail_archive_imports(import_id, message_key, message_id, state, error) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING', [imp!.id, key, messageId, state, error]);
  let sinceCheck = 0;

  for await (const e of readIndexAt(store, rb, m)) {
    const accountId = accountMap.get(e.accountKey);
    if (!accountId || done.has(e.messageKey)) continue;
    if (++sinceCheck % 25 === 0) {
      await flush();
      const cur = await one<{ status: string }>('SELECT status FROM archive_imports WHERE id = ?', [imp.id]);
      if (cur?.status === 'paused') return true;
      if (Date.now() - t0 > budget) return false;
    }
    try {
      if (await one('SELECT 1 FROM messages WHERE account_id = ? AND s3_key = ?', [accountId, `msg/${accountId}/${e.sha256}.eml`])) { await record(e.messageKey, 'skipped', null); delta.skipped++; continue; }
      let raw: Buffer;
      try { raw = await store.get(rb(e.emlPath)); }
      catch (err: any) { if (!isMissing(err)) throw err; await record(e.messageKey, 'failed', null, 'message file missing in the archive'); delta.failed++; continue; }
      if (sha256(raw) !== e.sha256) { await record(e.messageKey, 'failed', null, 'checksum mismatch: the archived copy is damaged'); delta.failed++; continue; }
      const mk = `${accountId}\u0000${e.mailboxPath}`;
      let mailboxId = mailboxIds.get(mk);
      if (!mailboxId) {
        const row = await one<{ id: number }>('SELECT id FROM mailboxes WHERE account_id = ? AND path = ?', [accountId, e.mailboxPath])
          ?? await one<{ id: number }>('INSERT INTO mailboxes(account_id, path, role, name) VALUES (?,?,?,?) RETURNING id', [accountId, e.mailboxPath, null, e.mailboxPath]);
        mailboxId = row!.id; mailboxIds.set(mk, mailboxId);
      }
      const uidRow = await one<{ uid: number }>('UPDATE mailboxes SET next_uid = next_uid + 1 WHERE id = ? RETURNING next_uid - 1 AS uid', [mailboxId]);
      const flags = new Set<string>();
      if (e.flags.seen) flags.add('\\Seen'); if (e.flags.flagged) flags.add('\\Flagged'); if (e.flags.answered) flags.add('\\Answered');
      const r = await ingestMessage({ accountId, mailboxId, uid: uidRow!.uid, raw, flags, internalDate: new Date(e.date), isLive: false });
      if (!r) { await record(e.messageKey, 'skipped', null); delta.skipped++; continue; }
      await run(`UPDATE messages SET classify_state = 'classified', disposition = 'keep', keep_reason = 'archived' WHERE id = ?`, [r.rowId]);
      if (cats.labels) for (const k of e.labelKeys) { const lid = maps.labels.get(k); if (lid) await run('INSERT INTO message_labels(message_id, label_id) VALUES (?,?) ON CONFLICT DO NOTHING', [r.rowId, lid]); }
      await record(e.messageKey, 'imported', r.rowId); delta.imported++;
    } catch (err: any) {
      if (isMissing(err)) { await record(e.messageKey, 'failed', null, String(err?.message ?? err).slice(0, 300)); delta.failed++; }
      else { await flush(); throw err; }     // a store that is down retries the job
    }
  }
  await flush();

  // finish: notes need the new message ids, account names need the dates
  if (cfg && cats.notes && !(imp.config_result as any)?.notes) {
    const notes = await importNotes(imp, cfg);
    await run('UPDATE archive_imports SET config_result = COALESCE(config_result, ?::jsonb) || ?::jsonb WHERE id = ?', ['{}', JSON.stringify({ notes }), imp.id]);
  }
  if (cats.ai && hasAiMemory(m) && !(imp.config_result as any)?.aiMessages) {
    const aiMessages = await importAiMessages(imp.user_id, store, rb, m, imp.id, maps.labels);
    await run('UPDATE archive_imports SET config_result = COALESCE(config_result, ?::jsonb) || ?::jsonb WHERE id = ?', ['{}', JSON.stringify({ aiMessages }), imp.id]);
  }
  await nameAccounts(Object.values(Object.fromEntries(accountMap)));
  const fin = (await byId(imp.id))!;
  await run("UPDATE archive_imports SET status = 'done', finished_at = ?, error = ? WHERE id = ? AND status <> 'paused'",
    [Date.now(), fin.failed ? `${fin.failed} message${fin.failed === 1 ? '' : 's'} could not be imported. Fix the source and press Retry.` : null, imp.id]);
  await audit(null, 'archive.import_done', { type: 'archive_import', id: imp.id }, { imported: fin.imported, skipped: fin.skipped, failed: fin.failed }, { userId: imp.user_id });
  await bumpState(); broadcast({ type: 'stateChange' }, imp.user_id);
  return true;
}

export async function pauseImport(userId: number, id: number): Promise<boolean> {
  const r = await one<{ id: number }>("UPDATE archive_imports SET status = 'paused' WHERE id = ? AND user_id = ? AND status IN ('queued','running') RETURNING id", [id, userId]);
  return !!r;
}
export async function resumeImport(userId: number, id: number): Promise<boolean> {
  const r = await one<{ id: number }>("UPDATE archive_imports SET status = 'queued', error = NULL WHERE id = ? AND user_id = ? AND status IN ('paused','failed') RETURNING id", [id, userId]);
  if (r) await enqueueJob(userId, 'archive.import', Date.now(), { importId: id });
  return !!r;
}
/** Failed items are tried again; everything already imported stays as it is. */
export async function retryImport(userId: number, id: number): Promise<boolean> {
  const imp = await getImport(userId, id);
  if (!imp || !['done', 'failed', 'paused'].includes(imp.status)) return false;
  const gone = await one<{ n: number }>("WITH d AS (DELETE FROM mail_archive_imports WHERE import_id = ? AND state = 'failed' RETURNING 1) SELECT COUNT(*)::int n FROM d", [id]);
  await run("UPDATE archive_imports SET status = 'queued', failed = GREATEST(0, failed - ?), error = NULL, finished_at = NULL WHERE id = ?", [gone?.n ?? 0, id]);
  await enqueueJob(userId, 'archive.import', Date.now(), { importId: id });
  return true;
}

export async function listFailures(id: number, limit = 100) {
  return q<{ message_key: string; error: string }>("SELECT message_key, error FROM mail_archive_imports WHERE import_id = ? AND state = 'failed' ORDER BY message_key LIMIT ?", [id, limit]);
}

/** "Remove imported mail": only the messages that came from this import (labels and other app data stay). */
export async function removeImport(userId: number, id: number): Promise<{ removed: number } | null> {
  const imp = await getImport(userId, id);
  if (!imp) return null;
  if (imp.status === 'running') await run("UPDATE archive_imports SET status = 'paused' WHERE id = ?", [id]);
  const rows = await q<{ message_id: number }>("SELECT message_id FROM mail_archive_imports WHERE import_id = ? AND state = 'imported' AND message_id IS NOT NULL", [id]);
  let removed = 0;
  for (const r of rows) {
    const msg = await one<{ s3_key: string }>('SELECT s3_key FROM messages WHERE id = ? AND user_id = ?', [r.message_id, userId]);
    if (!msg) continue;
    await deleteMessageRow(r.message_id);
    if (!(await one('SELECT 1 FROM messages WHERE s3_key = ? LIMIT 1', [msg.s3_key]))) await deleteBlob(msg.s3_key).catch(() => {});
    removed++;
  }
  // archived mailboxes that are empty now go too
  for (const aid of imp.account_ids ?? []) {
    if (!(await one('SELECT 1 FROM messages WHERE account_id = ? LIMIT 1', [aid]))) await run('DELETE FROM accounts WHERE id = ? AND user_id = ? AND archived', [aid, userId]);
  }
  await run('DELETE FROM archive_imports WHERE id = ?', [id]);
  await audit(null, 'archive.import_removed', { type: 'archive_import', id }, { name: imp.name, removed }, { userId });
  await bumpState(); broadcast({ type: 'stateChange' }, userId);
  return { removed };
}

registerJob('archive.import', async (job) => {
  const id = Number(job.payload?.importId);
  try {
    if (!(await runImportSlice(id))) await enqueueJob(job.user_id, 'archive.import', Date.now(), { importId: id });
  } catch (err: any) {
    const msg = String(err?.message ?? err).slice(0, 500);
    const fatal = err instanceof ArchiveError || job.attempts >= MAX_ATTEMPTS;
    await run("UPDATE archive_imports SET error = ?, status = CASE WHEN ? THEN 'failed' ELSE status END, finished_at = CASE WHEN ? THEN ? ELSE finished_at END WHERE id = ?", [msg, fatal, fatal, Date.now(), id]);
    if (fatal) { const r = await byId(id); if (r) broadcast({ type: 'stateChange' }, r.user_id); }
    if (fatal && err instanceof ArchiveError) return;
    throw err;
  }
});
