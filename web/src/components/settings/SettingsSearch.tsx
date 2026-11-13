/** Search box at the top of Settings: type "trash", "undo send", "api token"… and jump to the right tab. */
import { useMemo, useState } from 'react';
import { navigate } from '../../router.ts';

export interface SettingsEntry { label: string; tab: string; tabName: string; words?: string; admin?: boolean }

/** One row per option people look for. `words` are extra search terms. */
const ENTRIES: Omit<SettingsEntry, 'tabName'>[] = [
  { label: 'Undo send delay', tab: 'general', words: 'hold send countdown' },
  { label: 'Snooze and reply behaviour', tab: 'general', words: 'snoozed bring back' },
  { label: 'Keyboard shortcuts on/off', tab: 'general', words: 'keys hotkeys' },
  { label: 'Theme, colour mode, accent', tab: 'appearance', words: 'dark light rolltop density font' },
  { label: 'Add a mailbox', tab: 'mailboxes', words: 'account imap smtp gmail outlook pop3 mxroute own domain cloudflare' },
  { label: 'Mailbox "Send through" provider', tab: 'mailboxes', words: 'smtp relay outgoing' },
  { label: 'Share a mailbox', tab: 'mailboxes', words: 'shared inbox team role' },
  { label: 'Businesses, identities, signatures', tab: 'businesses', words: 'brand logo disclaimer from address' },
  { label: 'Disposable addresses', tab: 'disposable', words: 'alias burner disposable stop start keep catch-all catchall leak expire week unknown address' },
  { label: 'Sending providers (SendGrid, Brevo, SES, Mailgun, Postmark)', tab: 'sending', words: 'smtp api bounce dns spf dkim dmarc' },
  { label: 'Labels and colours', tab: 'labels', words: 'tags categories' },
  { label: 'Templates / quick replies', tab: 'templates', words: 'canned replies snippets' },
  { label: 'Notifications and VIP senders', tab: 'notifications', words: 'bell push alerts vip' },
  { label: 'Trusted senders (phishing warnings)', tab: 'security', words: 'phishing spam safe sender' },
  { label: 'Two-factor authentication, sessions, password', tab: 'security', words: '2fa totp passkey sign out sessions' },
  { label: 'PGP and S/MIME keys', tab: 'encryption', words: 'encrypt sign certificate p12 openpgp gpg' },
  { label: 'Rules', tab: 'rules', words: 'automation ai classify' },
  { label: 'Trash retention (empty Trash after N days)', tab: 'storage', words: 'trash deleted recycle bin recycle-bin bin retention delete deleted mail purge empty auto delete older than days keep' },
  { label: 'Dry run (retention only logs, deletes nothing)', tab: 'storage', words: 'trash deleted recycle bin retention sweep test mode' },
  { label: 'Run the retention sweep now', tab: 'storage', words: 'trash deleted recycle bin retention purge clean up' },
  { label: 'Read later: archive after reading, delete after N days', tab: 'newsletters', words: 'unsubscribe newsletter archive after read retention deleted' },
  { label: 'Log retention (auto-clear logs after N days)', tab: 'storage', words: 'logs keep days retention clean up' },
  { label: 'Import a rules spreadsheet', tab: 'automation', words: 'xlsx excel config seed labels rules' },
  { label: 'Filters / block a sender or company', tab: 'filters', words: 'block spam junk domain move delete deleted trash bin stop' },
  { label: 'AI provider and model', tab: 'ai', words: 'openai anthropic ollama key classify' },
  { label: 'Webhooks', tab: 'integrations', words: 'http post events signature' },
  { label: 'API tokens', tab: 'integrations', words: 'rest api v1 bearer' },
  { label: 'Connect DMS, BizBooks, Todoist, Vikunja', tab: 'integrations', words: 'tasks connector' },
  { label: 'Lead sources', tab: 'leads', words: 'form enquiry website quote' },
  { label: 'Contacts and address book', tab: 'contacts', words: 'carddav import export csv vcf google outlook iphone gmail groups merge duplicates add contact' },
  { label: 'Automatically save people I write to or reply to (contact auto-save)', tab: 'contacts', words: 'autosave auto-save save contacts other contacts gmail remember recipients autocomplete switch off' },
  { label: 'App passwords, IMAP/SMTP/CardDAV for phones', tab: 'devices', words: 'thunderbird apple mail android' },
  { label: 'Critical alerts: be told when a mailbox stops working (SMS, Twilio, Telegram, phone gateway, email)', tab: 'alerts', words: 'alert sms twilio telegram notify down offline stopped broken phone gateway bot red pinned reminder whatsapp no' },
  { label: 'Health checks and alerts', tab: 'health', words: 'status monitor ignore mailbox' },
  { label: 'Logs', tab: 'logs', words: 'errors debug activity' },
  { label: 'Audit log (who did what), audit retention', tab: 'audit', words: 'security history export csv retention keep days' },
  { label: 'Database maintenance (automatic cleanups, vacuum, log)', tab: 'storage', admin: true, words: 'maintenance cleanup clean up vacuum database prune bloat analyze reindex orphan orphaned files disk space size sessions events notifications logs retention schedule' },
  { label: 'Reclaim disk space (VACUUM FULL) and find orphaned files', tab: 'storage', admin: true, words: 'vacuum full bloat orphan orphaned files blobs delete disk space maintenance cleanup' },
  { label: 'Storage buckets (mail, backups, spool)', tab: 'storage', admin: true, words: 'r2 b2 s3 minio migrate bucket' },
  { label: 'Archives: open an archive from a bucket and import old mail', tab: 'archives', admin: true, words: 'import archive viewing old mail bucket attach zip viewer second instance read-only' },
  { label: 'Backups and restore', tab: 'backup', admin: true, words: 'export import restore drill mirror archive old mail older than years move copy' },
  { label: 'Users and roles', tab: 'users', admin: true, words: 'invite admin member password reset disable quota storage limit mailbox for user sign out everywhere' },
];

export default function SettingsSearch({ tabs, isAdmin }: { tabs: { id: string; name: string; group?: string; admin?: boolean }[]; isAdmin: boolean }) {
  const [q, setQ] = useState('');
  const names = useMemo(() => Object.fromEntries(tabs.map((t) => [t.id, t.name])), [tabs]);
  const hits = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const all: SettingsEntry[] = [
      ...ENTRIES.map((e) => ({ ...e, tabName: names[e.tab] ?? e.tab })),
      ...tabs.map((t) => ({ label: t.name, tab: t.id, tabName: t.name, admin: t.admin, words: 'tab page' })),
    ];
    const seen = new Set<string>();
    return all.filter((e) => (!e.admin || isAdmin) && terms.every((w) => `${e.label} ${e.tabName} ${e.words ?? ''}`.toLowerCase().includes(w)))
      .filter((e) => { const k = e.tab + e.label; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 8);
  }, [q, names, tabs, isAdmin]);

  const pick = (e: SettingsEntry) => { setQ(''); navigate({ page: 'settings', tab: e.tab }); };
  return (
    <div className="settings-search">
      <input className="text-input" type="search" placeholder="Search settings…" aria-label="Search settings" value={q}
        onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && hits[0]) pick(hits[0]); if (e.key === 'Escape') setQ(''); }} />
      {q.trim() && (
        <div className="settings-search-results" role="listbox">
          {hits.length ? hits.map((e) => (
            <button key={e.tab + e.label} className="side-item" role="option" onClick={() => pick(e)}>
              <span className="name">{e.label}</span><span className="where">Settings → {e.tabName}</span>
            </button>
          )) : <div className="empty">No settings match “{q}”.</div>}
        </div>
      )}
    </div>
  );
}
