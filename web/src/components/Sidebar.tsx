/**
 * Sidebar (T1 F-10):
 *   [Compose]
 *   Inbox · (Review when there is something to decide) · Starred · Drafts · Scheduled · Sent
 *   Templates · Spam · Bin · More ▸ (Archive and anything moved there in Settings → Labels)
 *   ── Labels A–Z (nested, hidden ones left out) [+ New label]
 *   ── Folders (only when the scope is a single mailbox)
 */
import { useEffect, useMemo, useState } from 'react';
import type { ComponentType } from 'react';
import type { ApiLabel } from '@seamless/shared';
import { useMail, scopeToSlug } from '../state/mail.ts';
import { useCompose } from '../state/compose.ts';
import { useSession, DEFAULT_SIDEBAR, SIDEBAR_FOLDERS } from '../state/session.ts';
import { useRouter, navigate, FOLDER_ROLE, FOLDER_TITLE } from '../router.ts';
import {
  InboxIcon, DraftsIcon, SentIcon, ScheduledIcon, ArchiveIcon, JunkIcon, TrashIcon, FolderIcon, ComposeIcon,
  CaretDownIcon, CaretRightIcon, StarIcon, ReviewIcon, TemplateIcon, MailLogo, SidebarCollapseIcon, SettingsIcon, SnoozeIcon, WaitingIcon,
} from '../icons.tsx';
import { IconContext } from '@phosphor-icons/react';
import { api } from '../api/client.ts';
import { toast } from '../toast.ts';
import { useShared } from '../state/shared.ts';
import LabelColorPicker from './LabelColorPicker.tsx';

const FOLDER_ICON: Record<string, ComponentType<{ className?: string }>> = {
  inbox: InboxIcon, starred: StarIcon, drafts: DraftsIcon, scheduled: ScheduledIcon, sent: SentIcon,
  templates: TemplateIcon, spam: JunkIcon, bin: TrashIcon, archive: ArchiveIcon, review: ReviewIcon,
  snoozed: SnoozeIcon, waiting: WaitingIcon,
};

interface LabelNode { label: ApiLabel; children: LabelNode[] }

/** Tree of labels in the chosen order; hidden ones (and "only if unread" with none) dropped. */
export function labelTree(labels: ApiLabel[], sort: 'az' | 'manual' | 'count', forSidebar: boolean): LabelNode[] {
  const visible = forSidebar
    ? labels.filter((l) => l.sidebarVisibility !== 'hidden' && !(l.sidebarVisibility === 'unread' && !(l.unread ?? 0)))
    : labels;
  const ids = new Set(visible.map((l) => l.id));
  const cmp = (a: ApiLabel, b: ApiLabel) =>
    sort === 'manual' ? (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name)
      : sort === 'count' ? (b.total ?? 0) - (a.total ?? 0) || a.name.localeCompare(b.name)
        : a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  const build = (parent: number | null): LabelNode[] => visible
    .filter((l) => (l.parentId && ids.has(l.parentId) ? l.parentId : null) === parent)
    .sort(cmp)
    .map((label) => ({ label, children: build(label.id) }));
  return build(null);
}

export default function Sidebar({ open, onNavigate, onAddLabel }: { open: boolean; onNavigate: () => void; onAddLabel: () => void }) {
  const mailboxes = useMail((s) => s.mailboxes);
  const labels = useMail((s) => s.labels);
  const reviewCount = useMail((s) => s.reviewCount);
  const scope = useMail((s) => s.scope);
  const overview = useMail((s) => s.overview);
  const route = useRouter((s) => s.route);
  const openBlank = useCompose((s) => s.openBlank);
  const settings = useSession((s) => s.settings);
  const saveSettings = useSession((s) => s.saveSettings);
  const [moreOpen, setMoreOpen] = useState(false);
  const [collapsedLabels, setCollapsedLabels] = useState<Set<number>>(new Set());

  const saved = settings.sidebar ?? DEFAULT_SIDEBAR;
  // folders added after the user saved their layout (Snoozed, Waiting for reply) show up under "More"
  const sidebar = { order: saved.order, more: [...saved.more, ...SIDEBAR_FOLDERS.filter((f) => !saved.order.includes(f) && !saved.more.includes(f))] };
  const slug = scopeToSlug(scope, overview);
  const unifiedByRole = new Map(mailboxes.filter((m) => m.accountId === null).map((m) => [m.role, m]));
  const singleAccount = scope.startsWith('account:') ? Number(scope.slice(8)) : null;
  const ownFolders = singleAccount ? mailboxes.filter((m) => m.accountId === singleAccount && !m.role) : [];
  const tree = useMemo(() => labelTree(labels, settings.labelSort ?? 'az', true), [labels, settings.labelSort]);

  const go = (folder: string, arg?: string) => { navigate({ page: 'mail', scope: slug, folder, arg }); onNavigate(); };
  const isActive = (folder: string, arg?: string) =>
    route.page === 'mail' && route.folder === folder && (arg === undefined || route.arg === arg);

  const ownedShared = useShared((st) => st.ownedShared);
  useEffect(() => { void useShared.getState().loadOwned(); }, [overview]);
  const hasShared = (overview?.shared?.length ?? 0) > 0 || ownedShared.length > 0;

  const folderItem = (folder: string, nested = false) => {
    const Icon = FOLDER_ICON[folder] ?? FolderIcon;
    const role = FOLDER_ROLE[folder];
    const mb = role ? unifiedByRole.get(role as any) : undefined;
    const title = FOLDER_TITLE[folder] ?? folder;
    let count: React.ReactNode = null;
    if (folder === 'inbox' && mb && mb.unreadEmails > 0) count = <span className="count">{mb.unreadEmails}</span>;
    if ((folder === 'drafts' || folder === 'scheduled') && mb && mb.totalEmails > 0) count = <span className="count muted">{mb.totalEmails}</span>;
    if (folder === 'spam' && mb && mb.unreadEmails > 0) count = <span className="count muted">{mb.unreadEmails}</span>;
    if (folder === 'review') count = <span className="count">{reviewCount}</span>;
    return (
      <button key={folder} className={`side-item ${nested ? 'sub' : ''} ${isActive(folder) ? 'active' : ''}`} onClick={() => go(folder)} title={title}>
        <Icon className="glyph" />
        <span className="name">{title}</span>
        {count}
      </button>
    );
  };

  const labelNode = (n: LabelNode, depth: number): React.ReactNode => {
    const l = n.label;
    const collapsed = collapsedLabels.has(l.id);
    return (
      <div key={l.id}>
        <div className={`side-item label-item ${isActive('label', String(l.id)) ? 'active' : ''}`} style={{ paddingLeft: depth * 14 }}>
          {n.children.length > 0 ? (
            <button className="label-caret" aria-label={collapsed ? 'Expand' : 'Collapse'}
              onClick={() => { const s = new Set(collapsedLabels); if (collapsed) s.delete(l.id); else s.add(l.id); setCollapsedLabels(s); }}>
              {collapsed ? <CaretRightIcon size={11} /> : <CaretDownIcon size={11} />}
            </button>
          ) : <span className="label-caret" />}
          <LabelColorPicker label={l} dotSize={9.9} stop />
          <button className="label-name-btn" onClick={() => go('label', String(l.id))} title={l.name}>
            <span className="name">{l.name}</span>
            {(l.unread ?? 0) > 0 && <span className="count muted">{l.unread}</span>}
          </button>
        </div>
        {!collapsed && n.children.map((c) => labelNode(c, depth + 1))}
      </div>
    );
  };

  // space used by what the switcher is showing (mailbox / category / everything)
  const [usage, setUsage] = useState<{ bytes: number; messages: number } | null>(null);
  useEffect(() => {
    let alive = true;
    api.get<{ bytes: number; messages: number }>(`/api/storage/usage?scope=${encodeURIComponent(scope)}`)
      .then((u) => { if (alive) setUsage(u); }).catch(() => {});
    return () => { alive = false; };
  }, [scope, overview]);   // overview refreshes after every sync/state change
  const sizeLabel = usage ? formatBytes(usage.bytes).replace(' ', '') : '';
  const sizeTitle = (() => {
    if (!usage) return '';
    const mb = scope.startsWith('account:') ? overview?.mailboxes.find((m) => `account:${m.id}` === scope) : null;
    return `${mb ? `${mb.name || mb.email}: ` : ''}${usage.messages.toLocaleString()} messages, ${formatBytes(usage.bytes)} stored`;
  })();

  return (
    <IconContext.Provider value={{ weight: settings.theme === 'simply' ? 'regular' : 'fill', size: 18 }}>
    <nav className={`sidebar ${open ? 'open' : ''} ${settings.sidebarCollapsed ? 'collapsed' : ''}`} aria-label="Folders">
      <div className="side-brand mobile-only"><MailLogo size="1.4em" /><span className="app-name">{settings.appName || 'Seamless'}</span></div>
      <div className="compose-actions">
        <button className="btn primary compose-btn" onClick={openBlank} title="Compose (c)"><ComposeIcon /> <span className="compose-label">Compose</span></button>
      </div>

      <div className="side-section">
        {sidebar.order.map((folder) => (
          <div key={folder}>
            {folderItem(folder)}
            {folder === 'inbox' && (reviewCount > 0 || isActive('review')) && folderItem('review', true)}
          </div>
        ))}
        {sidebar.more.length > 0 && (
          <>
            <button className="side-item more-toggle" onClick={() => setMoreOpen((v) => !v)} aria-expanded={moreOpen}>
              {moreOpen ? <CaretDownIcon className="glyph" size={14} /> : <CaretRightIcon className="glyph" size={14} />}
              <span className="name">{moreOpen ? 'Less' : 'More'}</span>
            </button>
            {(moreOpen || sidebar.more.some((f) => isActive(f))) && sidebar.more.map((f) => folderItem(f, true))}
          </>
        )}
      </div>

      <div className="side-section">
        <div className="side-header">
          <span>Labels</span>
          <button className="icon-btn side-add" title="New label" aria-label="New label" onClick={onAddLabel}>+</button>
        </div>
        {tree.map((n) => labelNode(n, 0))}
        {labels.length === 0 && <button className="side-item side-hint" onClick={onAddLabel}><span className="name">+ New label</span></button>}
      </div>

      {hasShared && (
        <div className="side-section">
          <div className="side-header"><span>Shared</span></div>
          {(['assigned', 'unassigned'] as const).map((f) => (
            <button key={f} className={`side-item ${isActive(f) ? 'active' : ''}`} onClick={() => go(f)}>
              <FolderIcon className="glyph" /><span className="name">{FOLDER_TITLE[f]}</span>
            </button>
          ))}
        </div>
      )}

      {ownFolders.length > 0 && (
        <div className="side-section">
          <div className="side-header"><span>Folders</span></div>
          {ownFolders.map((mb) => (
            <button key={mb.id} className={`side-item ${isActive('folder', mb.id.slice(3)) ? 'active' : ''}`} onClick={() => go('folder', mb.id.slice(3))}>
              <FolderIcon className="glyph" />
              <span className="name">{mb.name}</span>
              {mb.unreadEmails > 0 && <span className="count muted">{mb.unreadEmails}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="side-foot">
        <span className="side-size" title={sizeTitle}>{sizeLabel}</span>
        <button className="icon-btn desktop-only" title={settings.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={settings.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={() => saveSettings({ sidebarCollapsed: !settings.sidebarCollapsed })}><SidebarCollapseIcon size={17} weight="regular" /></button>
      </div>
    </nav>
    </IconContext.Provider>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
