import { useState } from 'react';
import type { ApiEmail } from '@seamless/shared';
import { api } from '../api/client.ts';
import { useMail } from '../state/mail.ts';
import { toast } from '../toast.ts';
import { ReadLaterIcon } from '../icons.tsx';

type Choice = 'inbox' | 'read_later' | 'unsubscribed';

/** Slim bar above a newsletter (T6.3 F-40): Keep in Inbox / Read later / Unsubscribe — shown until the sender has a choice. */
export function NewsletterPrompt({ email }: { email: ApiEmail }) {
  const n = email.newsletter;
  const refreshCurrent = useMail((s) => s.refreshCurrent);
  const [busy, setBusy] = useState(false);
  if (!n) return null;

  const choose = async (choice: Choice) => {
    setBusy(true);
    try {
      await api.put('/api/newsletters/senders', { sender: n.sender, choice, emailId: email.id });
      toast(choice === 'read_later' ? 'Future issues go to Read later' : 'Future issues stay in your Inbox');
      await refreshCurrent();
    } catch (e: any) { toast(e?.message ?? 'Could not save that'); }
    finally { setBusy(false); }
  };
  const unsubscribe = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ method: string; url?: string }>('/api/newsletters/unsubscribe', { emailId: email.id });
      if (r.method === 'link' && r.url) window.open(r.url, '_blank', 'noopener,noreferrer');
      toast(r.method === 'link' ? 'Finish unsubscribing on the sender’s page; future mail goes to Bin' : 'Unsubscribed; future mail goes to Bin');
      await refreshCurrent();
    } catch (e: any) { toast(e?.message ?? 'Could not unsubscribe'); }
    finally { setBusy(false); }
  };

  if (n.choice === 'unsubscribed') return <div className="newsletter-bar done">You unsubscribed from {n.sender}.</div>;
  return (
    <div className="newsletter-bar" role="region" aria-label="Newsletter">
      <ReadLaterIcon size={16} />
      <span className="nl-text">{n.choice ? <>Newsletter from <strong>{n.sender}</strong> — currently {n.choice === 'read_later' ? 'in Read later' : 'kept in your Inbox'}.</> : <>This looks like a newsletter from <strong>{n.sender}</strong>.</>}</span>
      <span className="nl-actions">
        {n.choice !== 'inbox' && <button className="btn ghost" disabled={busy} onClick={() => void choose('inbox')}>Keep in Inbox</button>}
        {n.choice !== 'read_later' && <button className="btn ghost" disabled={busy} onClick={() => void choose('read_later')}>Read later</button>}
        {n.unsubscribe && <button className="btn ghost danger" disabled={busy} onClick={() => void unsubscribe()}>Unsubscribe</button>}
      </span>
    </div>
  );
}
