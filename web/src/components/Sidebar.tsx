import { useState } from 'react';
import type { ComponentType } from 'react';
import { useMail, type View } from '../state/mail.ts';
import { useCompose } from '../state/compose.ts';
import type { ApiMailbox } from '@seamless/shared';
import { InboxIcon, DraftsIcon, SentIcon, ScheduledIcon, ArchiveIcon, JunkIcon, TrashIcon, FolderIcon, ComposeIcon, CaretDownIcon, CaretRightIcon, StarIcon, ReviewIcon } from '../icons.tsx';

const STARRED_VIEW: View = { kind: 'search', query: 'is:starred', title: 'Starred' };
const REVIEW_VIEW: View = { kind: 'review', title: 'Review' };
// sidebar display order; 'starred'/'review' are synthetic views, the rest are unified mailboxes by role
const UNIFIED_ORDER = ['inbox', 'starred', 'review', 'scheduled', 'drafts', 'sent', 'archive', 'junk', 'trash'];

const ROLE_ICON: Record<string, ComponentType<{ className?: string }>> = {
  inbox: InboxIcon, drafts: DraftsIcon, sent: SentIcon, scheduled: ScheduledIcon, archive: ArchiveIcon, junk: JunkIcon, trash: TrashIcon,
};

function BoxGlyph({ mb }: { mb: ApiMailbox }) {
  const Icon = (mb.role && ROLE_ICON[mb.role]) || FolderIcon;
  return <Icon className="glyph" />;
}

export default function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const mailboxes = useMail((s) => s.mailboxes);
  const labels = useMail((s) => s.labels);
  const reviewCount = useMail((s) => s.reviewCount);
  const view = useMail((s) => s.view);
  const setView = useMail((s) => s.setView);
  const openBlank = useCompose((s) => s.openBlank);
  const [expandedAccounts, setExpandedAccounts] = useState<Set<number>>(new Set());

  const unified = mailboxes.filter((m) => m.accountId === null);
  const accounts = new Map<number, ApiMailbox[]>();
  for (const mb of mailboxes) {
    if (mb.accountId === null) continue;
    if (!accounts.has(mb.accountId)) accounts.set(mb.accountId, []);
    accounts.get(mb.accountId)!.push(mb);
  }

  const unifiedByRole = new Map(unified.map((m) => [m.role, m]));

  const go = (v: View) => { setView(v); onNavigate(); };
  const isActive = (v: Partial<View>) =>
    (v.mailboxId && view.kind === 'mailbox' && view.mailboxId === v.mailboxId) ||
    (v.labelId !== undefined && view.kind === 'label' && view.labelId === v.labelId);
  const starredActive = view.kind === 'search' && view.query === 'is:starred';

  return (
    <nav className={`sidebar ${open ? 'open' : ''}`}>
      <button className="btn primary compose-btn" onClick={openBlank}><ComposeIcon /> Compose</button>

      <div className="side-section">
        {UNIFIED_ORDER.map((role) => {
          if (role === 'starred') {
            return (
              <button key="starred" className={`side-item ${starredActive ? 'active' : ''}`} onClick={() => go(STARRED_VIEW)}>
                <StarIcon className="glyph" weight="fill" />
                <span className="name">Starred</span>
              </button>
            );
          }
          if (role === 'review') {
            if (reviewCount === 0 && view.kind !== 'review') return null; // appears only when there is something to decide
            return (
              <button key="review" className={`side-item ${view.kind === 'review' ? 'active' : ''}`} onClick={() => go(REVIEW_VIEW)}>
                <ReviewIcon className="glyph" />
                <span className="name">Review</span>
                {reviewCount > 0 && <span className="count">{reviewCount}</span>}
              </button>
            );
          }
          const mb = unifiedByRole.get(role as any);
          if (!mb) return null;
          return (
            <button
              key={mb.id}
              className={`side-item ${isActive({ mailboxId: mb.id }) ? 'active' : ''}`}
              onClick={() => go({ kind: 'mailbox', mailboxId: mb.id, title: mb.name })}
            >
              <BoxGlyph mb={mb} />
              <span className="name">{mb.name}</span>
              {mb.role === 'inbox' && mb.unreadEmails > 0 && <span className="count">{mb.unreadEmails}</span>}
              {mb.role === 'drafts' && mb.totalEmails > 0 && <span className="count muted">{mb.totalEmails}</span>}
            </button>
          );
        })}
      </div>

      {labels.length > 0 && (
        <div className="side-section">
          <div className="side-header">Labels</div>
          {labels.map((l) => (
            <button
              key={l.id}
              className={`side-item ${isActive({ labelId: l.id }) ? 'active' : ''}`}
              onClick={() => go({ kind: 'label', labelId: l.id, title: l.name })}
            >
              <span className="label-dot" style={{ background: l.color }} />
              <span className="name">{l.name}</span>
            </button>
          ))}
        </div>
      )}

      {accounts.size > 0 && (
        <div className="side-section">
          <div className="side-header">Accounts</div>
          {[...accounts.entries()].map(([accountId, boxes]) => {
            const inbox = boxes.find((b) => b.role === 'inbox');
            const email = boxes[0] ? emailForAccount(boxes[0]) : `#${accountId}`;
            const expanded = expandedAccounts.has(accountId);
            return (
              <div key={accountId}>
                <button
                  className="side-item"
                  onClick={() => {
                    const next = new Set(expandedAccounts);
                    if (expanded) next.delete(accountId); else next.add(accountId);
                    setExpandedAccounts(next);
                  }}
                >
                  <span className="acct-dot" style={{ background: accountColor(accountId) }} />
                  <span className="name" title={email}>{email}</span>
                  {inbox && inbox.unreadEmails > 0 && <span className="count muted">{inbox.unreadEmails}</span>}
                  {expanded ? <CaretDownIcon size={12} color="var(--md-text-faint)" /> : <CaretRightIcon size={12} color="var(--md-text-faint)" />}
                </button>
                {expanded && boxes.map((mb) => (
                  <button
                    key={mb.id}
                    className={`side-item sub ${isActive({ mailboxId: mb.id }) ? 'active' : ''}`}
                    onClick={() => go({ kind: 'mailbox', mailboxId: mb.id, title: `${email} / ${mb.name}` })}
                  >
                    <BoxGlyph mb={mb} />
                    <span className="name">{mb.name}</span>
                    {mb.unreadEmails > 0 && <span className="count muted">{mb.unreadEmails}</span>}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </nav>
  );
}

// account email/color live on messages; sidebar derives from mailbox rows via the mail store
function emailForAccount(mb: ApiMailbox): string {
  const emails = useMail.getState().emails;
  for (const e of Object.values(emails)) {
    if (e.accountId === mb.accountId) return e.accountEmail;
  }
  return useCompose.getState().identities.find((i) => i.accountId === mb.accountId && !i.isAlias)?.email ?? `Account ${mb.accountId}`;
}

function accountColor(accountId: number): string {
  const emails = useMail.getState().emails;
  for (const e of Object.values(emails)) {
    if (e.accountId === accountId) return e.accountColor;
  }
  return 'var(--md-border-strong)';
}
