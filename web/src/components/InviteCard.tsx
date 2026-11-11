import { useState } from 'react';
import type { ApiInvite } from '@seamless/shared';
import { api } from '../api/client.ts';
import { toast } from '../toast.ts';
import { DownloadIcon } from '../icons.tsx';

const USER_TZ = 'Australia/Perth';

function fmt(ms: number, tz: string, allDay: boolean): string {
  return new Intl.DateTimeFormat('en-AU', allDay
    ? { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }
    : { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

const LABEL: Record<string, string> = { ACCEPTED: 'You accepted', TENTATIVE: 'You replied maybe', DECLINED: 'You declined' };

/** Calendar invite card shown at the top of the reading pane (T4 F-33). */
export default function InviteCard({ invite, onChange }: { invite: ApiInvite; onChange: (i: ApiInvite) => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const cancelled = invite.status === 'cancelled';
  const orgZone = invite.tz && invite.tz !== USER_TZ ? invite.tz : null;

  async function reply(partstat: 'ACCEPTED' | 'TENTATIVE' | 'DECLINED') {
    setBusy(true);
    try { onChange(await api.post<ApiInvite>(`/api/invites/${invite.id}/rsvp`, { partstat, note })); toast('Reply sent'); }
    catch (e: any) { toast(e?.message ?? 'Could not send the reply'); }
    finally { setBusy(false); }
  }
  async function addToCalendar() {
    setBusy(true);
    try { await api.post(`/api/invites/${invite.id}/caldav`); toast('Added to your calendar'); }
    catch (e: any) { toast(e?.message ?? 'Could not add to the calendar'); }
    finally { setBusy(false); }
  }

  return (
    <div className={`invite-card${cancelled ? ' cancelled' : ''}`}>
      <div className="invite-title">{invite.summary || '(no title)'}{cancelled && <span className="invite-badge">Cancelled</span>}</div>
      {invite.startsAt !== null && (
        <div className="invite-row">
          {fmt(invite.startsAt, USER_TZ, invite.allDay)}{invite.endsAt && !invite.allDay ? ` – ${new Intl.DateTimeFormat('en-AU', { timeZone: USER_TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(invite.endsAt))}` : ''}
          {orgZone && <span className="invite-faint"> · {fmt(invite.startsAt, orgZone, false)} ({orgZone})</span>}
        </div>
      )}
      {invite.videoUrl && <div className="invite-row"><a href={invite.videoUrl} target="_blank" rel="noopener noreferrer">Join video call</a></div>}
      {invite.location && invite.location !== invite.videoUrl && <div className="invite-row">{invite.location}</div>}
      {invite.organizer && <div className="invite-row invite-faint">Organiser: {invite.organizer.name || invite.organizer.email}</div>}
      {invite.attendees.length > 0 && (
        <div className="invite-row invite-faint">With: {invite.attendees.map((a) => `${a.name || a.email}${a.partstat === 'ACCEPTED' ? ' ✓' : a.partstat === 'DECLINED' ? ' ✗' : ''}`).join(', ')}</div>
      )}
      <div className="invite-actions">
        {invite.canRsvp && !cancelled && (<>
          <input className="invite-note" placeholder="Add a note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn" disabled={busy} onClick={() => void reply('ACCEPTED')}>Accept</button>
          <button className="btn" disabled={busy} onClick={() => void reply('TENTATIVE')}>Maybe</button>
          <button className="btn" disabled={busy} onClick={() => void reply('DECLINED')}>Decline</button>
        </>)}
        {invite.myPartstat && LABEL[invite.myPartstat] && <span className="invite-faint">{LABEL[invite.myPartstat]}</span>}
        {invite.caldavConnected && !cancelled && <button className="btn" disabled={busy} onClick={() => void addToCalendar()}>Add to calendar</button>}
        <a className="btn" href={`/api/invites/${invite.id}/ics`} download><DownloadIcon size={14} /> Download .ics</a>
      </div>
    </div>
  );
}
