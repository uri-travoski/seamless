/**
 * App header (T1 F-08 / theme track): brand on the left, search, the live-connection dot,
 * the scope switcher and — in the far top-right corner — the notification bell.
 * (Settings, refresh, log out and space used live in the sidebar footer; Help and shortcuts in Settings.)
 */
import { useEffect, useState } from 'react';
import { useSession } from '../../state/session.ts';
import { useMail, scopeToSlug } from '../../state/mail.ts';
import { useRouter, navigate } from '../../router.ts';
import { MenuIcon, SearchIcon, CloseIcon, MailLogo } from '../../icons.tsx';
import { NO_AUTOFILL } from '../../state/ui.ts';
import ScopeSwitcher from './ScopeSwitcher.tsx';
import NotificationBell from './NotificationBell.tsx';
import AppMenu from './AppMenu.tsx';
import { api } from '../../api/client.ts';

export default function AppHeader({ onMenu, connected }: { onMenu: () => void; connected: boolean }) {
  const appName = useSession((s) => s.settings.appName) || 'Seamless';
  const online = useMail((s) => s.online);
  const route = useRouter((s) => s.route);
  const [search, setSearch] = useState(route.page === 'mail' && route.folder === 'search' ? route.q ?? '' : '');

  // the dot: green = all well; amber = offline, or a mailbox is struggling; red = a mailbox has stopped working.
  // Mailboxes set to "ignore" (Settings → Health or the mailbox's own settings) don't count.
  const [mbHealth, setMbHealth] = useState<{ status: 'ok' | 'warn' | 'red'; problems: { email: string; status: string; error: string; paused: boolean }[] }>({ status: 'ok', problems: [] });
  useEffect(() => {
    let alive = true;
    const load = () => api.get<typeof mbHealth>('/api/health/mailboxes').then((r) => { if (alive) setMbHealth(r); }).catch(() => {});
    void load();
    const t = setInterval(load, 45_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const live = connected && online;

  const slug = () => scopeToSlug(useMail.getState().scope, useMail.getState().overview);
  const runSearch = () => {
    const q = search.trim();
    if (q) navigate({ page: 'mail', scope: slug(), folder: 'search', q });
  };
  const clear = () => {
    setSearch('');
    if (route.page === 'mail' && route.folder === 'search') navigate({ page: 'mail', scope: slug(), folder: 'inbox' });
  };

  return (
    <header className="topbar">
      <div className="brand">
        <button className="icon-btn mobile-only" onClick={onMenu} aria-label="Menu"><MenuIcon /></button>
        <button className="brand-link" onClick={() => navigate({ page: 'mail', scope: slug(), folder: 'inbox' })} title={`${appName} — Inbox`}>
          <MailLogo size="1.65em" /><span className="app-name">{appName}</span>
        </button>
      </div>
      <div className="search">
        <SearchIcon aria-hidden />
        <input
          id="global-search" type="search" name="seamless-mail-search" {...NO_AUTOFILL}
          placeholder="Search mail  (from: to: label: category: is:unread …)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') runSearch();
            if (e.key === 'Escape') { clear(); (e.target as HTMLInputElement).blur(); }
          }}
        />
        {!search && <kbd className="search-kbd" aria-hidden>/</kbd>}
        {search && <button className="icon-btn" onClick={clear} aria-label="Clear search"><CloseIcon /></button>}
      </div>
      <div className="spacer" />
      <div className="topbar-actions">
        <ScopeSwitcher dot={
          <span className={`conn-dot ${!live || mbHealth.status === 'warn' ? 'offline' : ''} ${live && mbHealth.status === 'red' ? 'bad' : ''}`} role="status"
            title={!live ? 'Offline or reconnecting — changes will appear once the connection is back'
              : mbHealth.status === 'ok' ? 'Live, and all mailboxes are working'
                : mbHealth.problems.map((p) => `${p.email}: ${p.paused ? 'paused' : p.status === 'red' ? 'not working' : 'having trouble'}`).join('\n')}
            aria-label={live ? (mbHealth.status === 'ok' ? 'Live connection, all mailboxes working' : 'Live connection, a mailbox has a problem') : 'Offline, reconnecting'} />
        } />
        <NotificationBell />
        <AppMenu />
      </div>
    </header>
  );
}
