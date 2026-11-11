/** Follow-up reminders (T2 F-19): the choices list, and the banner shown on a sent message whose reminder is due. */
import { useState } from 'react';
import type { ApiEmail } from '@seamless/shared';
import { actions } from '../state/actions.ts';
import { AlarmIcon, ReplyIcon } from '../icons.tsx';

export const FOLLOWUP_CHOICES: { days: number; label: string }[] = [
  { days: 1, label: '1 day' }, { days: 2, label: '2 days' }, { days: 3, label: '3 days' }, { days: 7, label: '1 week' },
];

/** Pick a number of days (shared by the compose menu and the "Follow up…" item). */
export function FollowupChoices({ onPick, current }: { onPick: (days: number) => void; current?: number }) {
  const [custom, setCustom] = useState('');
  return (
    <>
      <div className="switch-head">Remind me if no reply in</div>
      {FOLLOWUP_CHOICES.map((c) => (
        <button key={c.days} className={`side-item ${current === c.days ? 'active' : ''}`} role="menuitem" onClick={() => onPick(c.days)}>
          <span className="name">{c.label}</span>
        </button>
      ))}
      <div className="snooze-custom">
        <input type="number" min={1} max={365} className="text-input compact" style={{ width: 70 }} placeholder="days" value={custom}
          onChange={(e) => setCustom(e.target.value)} aria-label="Custom number of days" />
        <button className="btn small" disabled={!(Number(custom) >= 1)} onClick={() => onPick(Math.min(365, Math.round(Number(custom))))}>Set</button>
      </div>
    </>
  );
}

/** Above a sent message: "No reply yet" with Follow up now / Remind me again. */
export function FollowupBanner({ email }: { email: ApiEmail }) {
  if (!email.followupStatus || !email.followupDueAt) return null;
  const due = email.followupStatus === 'due';
  return (
    <div className={`followup-banner ${due ? 'due' : ''}`}>
      <AlarmIcon size={15} />
      <span>{due
        ? `You asked to be reminded — no reply yet (reminder was due ${new Date(email.followupDueAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}).`
        : `Reminder set: you'll be told on ${new Date(email.followupDueAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} if nobody replies.`}</span>
      <span className="grow" />
      {due && <button className="btn small" onClick={() => actions.reply(email.id)}><ReplyIcon size={13} /> Follow up now</button>}
      {due && <button className="btn ghost small" onClick={() => void actions.followup(email.id, 1)}>Remind me again (1 day)</button>}
      <button className="btn ghost small" onClick={() => void actions.cancelFollowup(email.followupId!)}>Cancel reminder</button>
    </div>
  );
}
