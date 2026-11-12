import { useEffect, useState, lazy, Suspense } from 'react';
import type { WsMessage } from '@seamless/shared';
import { useSession } from './state/session.ts';
import { useMail, scopeToSlug, slugToScope, type View } from './state/mail.ts';
import { useCompose } from './state/compose.ts';
import { useNotifs } from './state/notifications.ts';
import { useToasts } from './toast.ts';
import { useRouter, navigate, FOLDER_ROLE, FOLDER_TITLE, ROLE_FOLDER, type Route } from './router.ts';
import { getEmailsByIds } from './api/client.ts';
import Login from './components/Login.tsx';
import ForcePasswordChange from './components/ForcePasswordChange.tsx';
import Sidebar from './components/Sidebar.tsx';
import SaveViewDialog from './components/SaveViewDialog.tsx';
import { useViews } from './state/views.ts';
import MessageList from './components/MessageList.tsx';
import ReadingPane from './components/ReadingPane.tsx';
import ComposeDock from './components/ComposeDock.tsx';
import GettingStarted from './components/GettingStarted.tsx';
import AppHeader from './components/header/AppHeader.tsx';
import ShortcutsHelp from './components/ShortcutsHelp.tsx';
import { SnoozePopup } from './components/SnoozeMenu.tsx';
import { useUi } from './state/ui.ts';
import { ComposeIcon } from './icons.tsx';

const Settings = lazy(() => import('./components/settings/Settings.tsx'));
const HelpModal = lazy(() => import('./components/HelpModal.tsx'));
const NotificationsPage = lazy(() => import('./components/NotificationsPage.tsx'));
const LeadsPage = lazy(() => import('./components/LeadsPage.tsx'));
const OpenReport = lazy(() => import('./components/OpenReport.tsx'));
const TemplatesView = lazy(() => import('./components/TemplatesView.tsx'));

import { useShared, setSocket } from './state/shared.ts';

function useWebSocket(enabled: boolean): boolean {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 1000;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/api/ws`);
      ws.onopen = () => { setConnected(true); retry = 1000; setSocket(ws); };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as WsMessage;
          if (msg.type === 'presence') { useShared.getState().onPresence(msg); return; }
          if (msg.type === 'stateChange' || msg.type === 'newMail') {
            void useMail.getState().refreshCurrent();
            void useViews.getState().loadCounts();
          }
          if (msg.type === 'notifications' || msg.type === 'newMail') void useNotifs.getState().refresh();
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        setConnected(false); setSocket(null);
        if (!closed) {
          setTimeout(connect, retry);
          retry = Math.min(retry * 2, 15000);
        }
      };
    };
    connect();
    return () => { closed = true; ws?.close(); };
  }, [enabled]);
  return connected;
}

/** Folder slug (+ label/folder id, search text) → what the list shows. */
function folderView(route: Extract<Route, { page: 'mail' }>): View {
  const labels = useMail.getState().labels;
  const role = FOLDER_ROLE[route.folder];
  if (role) return { kind: 'mailbox', mailboxId: `u:${role}`, title: FOLDER_TITLE[route.folder] };
  if (route.folder === 'starred') return { kind: 'search', query: 'is:starred', title: 'Starred' };
  if (route.folder === 'assigned') return { kind: 'search', query: 'assigned:me status:open', title: 'Assigned to me' };
  if (route.folder === 'unassigned') return { kind: 'search', query: 'assigned:none status:open in:inbox', title: 'Unassigned' };
  if (route.folder === 'review') return { kind: 'review', title: 'Review' };
  if (route.folder === 'snoozed') return { kind: 'snoozed', title: 'Snoozed' };
  if (route.folder === 'readlater') return { kind: 'readlater', title: 'Read later' };
  if (route.folder === 'waiting') return { kind: 'waiting', title: 'Waiting for reply' };
  if (route.folder === 'label') {
    const id = Number(route.arg);
    return { kind: 'label', labelId: id, title: labels.find((l) => l.id === id)?.name ?? 'Label' };
  }
  if (route.folder === 'folder') {
    const mb = useMail.getState().mailboxes.find((m) => m.id === `mb:${route.arg}`);
    return { kind: 'mailbox', mailboxId: `mb:${route.arg}`, title: mb?.name ?? 'Folder' };
  }
  if (route.folder === 'search') return { kind: 'search', query: route.q ?? '', title: `Search: ${route.q ?? ''}` };
  return { kind: 'mailbox', mailboxId: 'u:inbox', title: 'Inbox' };
}

/** Keep the mail store in step with the URL (and the URL with the remembered scope). */
function useRouteSync(ready: boolean): void {
  const route = useRouter((s) => s.route);
  const overview = useMail((s) => s.overview);
  const labels = useMail((s) => s.labels);
  const lastScope = useSession((s) => s.settings.lastScope);

  useEffect(() => {
    if (!ready || !overview) return;
    if (route.page === 'mail') {
      if (!route.scope) {               // "/" or "/mail": open the remembered scope
        navigate({ page: 'mail', scope: scopeToSlug(lastScope || 'unified', overview), folder: 'inbox' }, { replace: true });
        return;
      }
      const scope = slugToScope(route.scope, overview);
      if (!scope) { navigate({ ...route, scope: 'unified' }, { replace: true }); return; }
      if (route.folder !== 'templates') useMail.getState().show(scope, folderView(route));
      else if (scope !== useMail.getState().scope) useMail.getState().show(scope, useMail.getState().view);
      if (scope !== useSession.getState().settings.lastScope) useSession.getState().saveSettings({ lastScope: scope });
    } else if (route.page === 'message') {
      // deep link (e.g. from a notification): show the message inside its folder
      void getEmailsByIds([route.emailId]).then(([e]) => {
        const st = useMail.getState();
        if (!e) { navigate({ page: 'mail', scope: scopeToSlug(st.scope, overview), folder: 'inbox' }, { replace: true }); return; }
        const folder = ROLE_FOLDER[e.mailboxRole ?? 'inbox'] ?? 'inbox';
        const scopeOk = st.scope === 'unified' || (st.overview?.mailboxes.find((m) => `account:${m.id}` === st.scope)?.id === e.accountId)
          || (st.overview?.categories.find((c) => `category:${c.id}` === st.scope)?.accountIds.includes(e.accountId));
        navigate({ page: 'mail', scope: scopeOk ? scopeToSlug(st.scope, overview) : 'unified', folder }, { replace: true });
        useMail.setState({ emails: { ...useMail.getState().emails, [e.id]: e } });
        setTimeout(() => void useMail.getState().select(e.id), 50);
      });
    }
  }, [ready, route, overview, lastScope]);

  // label names arrive after the first paint: fix the list title
  useEffect(() => {
    if (route.page === 'mail' && route.folder === 'label') {
      const v = useMail.getState().view;
      const name = labels.find((l) => l.id === Number(route.arg))?.name;
      if (name && v.kind === 'label' && v.title !== name) useMail.setState({ view: { ...v, title: name } });
    }
  }, [labels, route]);
}

export default function App() {
  const status = useSession((s) => s.status);
  const init = useSession((s) => s.init);
  const appName = useSession((s) => s.settings.appName) || 'Seamless';
  const mfaEnrollRequired = useSession((s) => s.mfaEnrollRequired);
  const mustChangePassword = useSession((s) => s.mustChangePassword);
  const route = useRouter((s) => s.route);
  const helpOpen = useUi((s) => s.helpOpen);
  const shortcutsOpen = useUi((s) => s.shortcutsOpen);
  const setUi = useUi((s) => s.set);
  const setHelpOpen = (v: boolean) => setUi({ helpOpen: v });
  const setShortcutsOpen = (v: boolean) => setUi({ shortcutsOpen: v });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const selectedId = useMail((s) => s.selectedId);
  const layout = useSession((s) => s.settings.layout);
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  const wsConnected = useWebSocket(status === 'ready' && !mustChangePassword);

  useEffect(() => { void init(); }, [init]);

  useEffect(() => {
    if (status === 'ready' && !mustChangePassword) {
      void useMail.getState().boot();
      void useCompose.getState().loadIdentities();
    }
  }, [status, mustChangePassword]);

  useRouteSync(status === 'ready');

  // an admin-required second factor: everything else waits until it's set up
  useEffect(() => {
    if (status === 'ready' && mfaEnrollRequired && !(route.page === 'settings' && route.tab === 'security')) {
      navigate({ page: 'settings', tab: 'security' }, { replace: true });
    }
  }, [status, mfaEnrollRequired, route]);

  // "?" opens the shortcut cheatsheet
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === '?' && useSession.getState().settings.shortcuts) { e.preventDefault(); useUi.getState().set({ shortcutsOpen: !useUi.getState().shortcutsOpen }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // unread badge in the tab title
  const unread = useMail((s) => s.mailboxes.find((m) => m.id === 'u:inbox')?.unreadEmails ?? 0);
  useEffect(() => {
    document.title = unread > 0 ? `Inbox (${unread}) - ${appName}` : appName;
  }, [unread, appName]);

  if (status === 'loading') return null;
  if (status !== 'ready') return <Login />;
  if (mustChangePassword) return <ForcePasswordChange />;

  const addLabel = () => { sessionStorage.setItem('seamless-new-label', '1'); navigate({ page: 'settings', tab: 'labels' }); };
  const isMail = route.page === 'mail' && route.folder !== 'templates';

  return (
    <div className="app">
      <SaveViewDialog />
      <AppHeader onMenu={() => setSidebarOpen(!sidebarOpen)} connected={wsConnected} />
      <div className={`main ${isMail && layout === 'table' ? 'table-mode' : ''} ${isMail && selectedId ? 'reading' : ''} ${isMail ? '' : 'page-mode'}`}>
        <Sidebar open={sidebarOpen} onNavigate={() => setSidebarOpen(false)} onAddLabel={addLabel} />
        {sidebarOpen && <div className="sidebar-scrim mobile-only" onClick={() => setSidebarOpen(false)} />}
        {isMail && <><MessageList /><ReadingPane /></>}
        <Suspense fallback={<div className="page-loading" />}>
          {route.page === 'mail' && route.folder === 'templates' && <TemplatesView />}
          {route.page === 'notifications' && <NotificationsPage params={route.params} />}
          {route.page === 'leads' && <LeadsPage params={route.params} />}
          {route.page === 'opens' && <OpenReport emailId={route.emailId} />}
          {route.page === 'settings' && <Settings tab={route.tab} />}
        </Suspense>
      </div>
      {isMail && !selectedId && <button className="mobile-compose-fab" aria-label="Compose" onClick={() => useCompose.getState().openBlank()}><ComposeIcon size={24} /></button>}
      <ComposeDock />
      <GettingStarted openSettings={(tab) => navigate({ page: 'settings', tab: tab === 'accounts' ? 'mailboxes' : tab })} openHelp={() => setHelpOpen(true)} />
      {helpOpen && <Suspense fallback={null}><HelpModal onClose={() => setHelpOpen(false)} /></Suspense>}
      <SnoozePopup />
      {shortcutsOpen && <ShortcutsHelp onClose={() => setShortcutsOpen(false)} />}
      <div className="toast-wrap" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
            {t.action && <button className="toast-action" onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>}
          </div>
        ))}
      </div>
    </div>
  );
}
