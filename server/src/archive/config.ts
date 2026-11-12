/** Archive old mail (T8.4): `config.json` — the app data a viewer needs so archived mail looks and works like the live app.
 *  Explicit column lists (never SELECT *) and a final scrub: no passwords, tokens, API/storage keys or private keys. */
import { q } from '../db.ts';
import { getBlob } from '../s3.ts';

export const SECRET_KEY = /pass|secret|token|api[_-]?key|private|creds|_enc$|credential|signing|hmac/i;
export const LOGO_MAX = 256 * 1024;

/** Deep copy without any key that looks secret. */
export function scrub<T>(v: T): T {
  if (Array.isArray(v)) return v.map(scrub) as any;
  if (v && typeof v === 'object') {
    const out: any = {};
    for (const [k, val] of Object.entries(v as any)) if (!SECRET_KEY.test(k)) out[k] = scrub(val);
    return out;
  }
  return v;
}

const lk = (id: number | null | undefined) => (id == null ? null : `L${id}`);
const parseJson = (s: string, fb: any) => { try { return JSON.parse(s); } catch { return fb; } };

export async function buildConfig(userId: number, archiveId: number, messageIds: number[]): Promise<Record<string, unknown>> {
  const labels = await q<any>(
    `SELECT id, name, color, description, sort, parent_id, sidebar_visibility, keep_default, retention_days, protected, auto_mark_read
     FROM labels WHERE user_id = ? ORDER BY id`, [userId]);
  const rules = await q<any>(
    `SELECT enabled, ord, match_field, match_value, exclude_contains, action, label_id, stop, note FROM rules WHERE user_id = ? ORDER BY ord, id`, [userId]);
  const filters = (await q<any>(`SELECT name, enabled, sort, match, conditions, actions, stop FROM filters WHERE user_id = ? ORDER BY sort, id`, [userId]))
    .map((f) => ({
      ...f, conditions: parseJson(f.conditions, []),
      actions: (parseJson(f.actions, []) as any[]).map((a) => (a?.type === 'label' && a.value ? { ...a, value: `L${a.value}`, labelKey: `L${a.value}` } : a)),
    }));
  const views = await q<any>(`SELECT name, icon, color, query, scope, sort, pinned, show_count, sort_order FROM saved_views WHERE user_id = ? ORDER BY sort_order, id`, [userId]);
  const templates = await q<any>(`SELECT name, category, subject, body_html, shortcut, kind, pinned, pin_order, send_direct FROM templates WHERE user_id = ? ORDER BY id`, [userId]);
  const contactRows = await q<any>(
    `SELECT c.id, c.display_name, c.org, c.notes, c.hidden, c.auto_created, c.phones_json, c.sent_count, c.received_count, c.last_interaction_at FROM contacts c WHERE c.user_id = ? ORDER BY c.id`, [userId]);
  const cEmails = await q<any>(
    `SELECT ce.contact_id, ce.email, ce.is_primary, ce.label FROM contact_emails ce JOIN contacts c ON c.id = ce.contact_id WHERE c.user_id = ? ORDER BY ce.contact_id`, [userId]);
  const cGroups = await q<any>(
    `SELECT m.contact_id, g.name FROM contact_group_members m JOIN contact_groups g ON g.id = m.group_id WHERE g.user_id = ? ORDER BY g.name`, [userId]);
  const contacts = contactRows.map((c) => ({
    displayName: c.display_name, org: c.org, notes: c.notes, hidden: c.hidden, autoCreated: c.auto_created,
    phones: parseJson(c.phones_json, []), sentCount: c.sent_count, receivedCount: c.received_count, lastInteractionAt: c.last_interaction_at == null ? null : Number(c.last_interaction_at),
    groups: cGroups.filter((g) => g.contact_id === c.id).map((g) => g.name),
    emails: cEmails.filter((e) => e.contact_id === c.id).map((e) => ({ email: e.email, primary: e.is_primary, label: e.label })),
  }));

  const bizRows = await q<any>(
    `SELECT id, name, short_name, logo_key, brand_color, website, phone, abn, address, default_signature_html, disclaimer_html FROM businesses WHERE user_id = ? ORDER BY id`, [userId]);
  const businesses: any[] = [];
  for (const b of bizRows) {
    let logo: { mime: string; base64: string } | null = null;
    if (b.logo_key) {
      try {
        const buf = await getBlob(b.logo_key);
        if (buf.length <= LOGO_MAX) {
          const ext = String(b.logo_key).split('.').pop();
          logo = { mime: ext === 'png' ? 'image/png' : ext === 'svg' ? 'image/svg+xml' : 'image/jpeg', base64: buf.toString('base64') };
        }
      } catch { /* logo blob missing: leave it out */ }
    }
    businesses.push({
      key: `B${b.id}`, name: b.name, shortName: b.short_name, brandColor: b.brand_color, website: b.website, phone: b.phone, abn: b.abn,
      address: b.address, signatureHtml: b.default_signature_html, disclaimerHtml: b.disclaimer_html, logo,
    });
  }
  const identities = (await q<any>(
    `SELECT account_id, business_id, email, display_name, signature_html, reply_to, bcc_self, is_default FROM identities WHERE user_id = ? ORDER BY id`, [userId]))
    .map((i) => ({ accountKey: `A${i.account_id}`, businessKey: i.business_id ? `B${i.business_id}` : null, email: i.email, displayName: i.display_name,
      signatureHtml: i.signature_html, replyTo: i.reply_to, bccSelf: i.bcc_self, isDefault: i.is_default }));

  const vip = await q<any>(`SELECT kind, value FROM vip_senders WHERE user_id = ? ORDER BY id`, [userId]);
  const trusted = await q<any>(`SELECT kind, value FROM trusted_senders WHERE user_id = ? ORDER BY id`, [userId]);
  const settings = (await q<any>(`SELECT key, value FROM user_settings WHERE user_id = ? ORDER BY key`, [userId])).filter((s) => !SECRET_KEY.test(s.key));
  const guidance = await q<any>(`SELECT enabled, guidance FROM preferences WHERE user_id = ? AND active ORDER BY id`, [userId]);
  const notes = messageIds.length
    ? await q<any>(`SELECT email_id, body, updated_at FROM notes WHERE user_id = ? AND email_id = ANY(?)`, [userId, messageIds.map((id) => `m${id}`)])
    : [];

  return scrub({
    format: 'seamless-archive-config', version: 1, archiveId,
    labels: labels.map((l) => ({
      key: lk(l.id), name: l.name, color: l.color, description: l.description, sort: l.sort, parentKey: lk(l.parent_id),
      sidebarVisibility: l.sidebar_visibility, keepDefault: l.keep_default, retentionDays: l.retention_days, protected: l.protected, autoMarkRead: l.auto_mark_read,
    })),
    rules: rules.map((r) => ({
      enabled: r.enabled, order: r.ord, matchField: r.match_field, matchValue: r.match_value, excludeContains: r.exclude_contains,
      action: r.action, labelKey: lk(r.label_id), stop: r.stop, note: r.note,
    })),
    filters,
    savedViews: views.map((v) => ({ name: v.name, icon: v.icon, color: v.color, query: v.query, scope: v.scope, sort: v.sort, pinned: v.pinned, showCount: v.show_count, order: v.sort_order })),
    templates: templates.map((t) => ({
      name: t.name, category: t.category, subject: t.subject, bodyHtml: t.body_html, shortcut: t.shortcut, kind: t.kind, pinned: t.pinned, pinOrder: t.pin_order, sendDirect: t.send_direct,
    })),
    contacts, businesses, identities,
    vipSenders: vip, trustedSenders: trusted,
    notes: notes.map((n) => ({ messageKey: `M${String(n.email_id).slice(1)}`, body: n.body, updatedAt: Number(n.updated_at) })),
    appearance: { settings }, aiGuidance: guidance,
  });
}
