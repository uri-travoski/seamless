import { useEffect, useState } from 'react';
import { useSession } from './state/session.ts';
import { useMail } from './state/mail.ts';
import { useCompose } from './state/compose.ts';
import { useToasts } from './toast.ts';
import Login from './components/Login.tsx';
import Sidebar from './components/Sidebar.tsx';
import MessageList from './components/MessageList.tsx';
import ReadingPane from './components/ReadingPane.tsx';
import ComposeDock from './components/ComposeDock.tsx';
import { MenuIcon, SearchIcon, CloseIcon, SettingsIcon, HelpIcon, MailLogo } from './icons.tsx';
import GettingStarted from './components/GettingStarted.tsx';
import { lazy, Suspense } from 'react';

const Settings = lazy(() => import('./components/settings/Settings.tsx'));
const HelpModal = lazy(() => import('./components/HelpModal.tsx'));
import type { WsMessage } from '@seamless/shared';

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
      ws.onopen = () => { setConnected(true); retry = 1000; };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as WsMessage;
          if (msg.type === 'stateChange' || msg.type === 'newMail') {
            void useMail.getState().refreshCurrent();
          }
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        setConnected(false);
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

export default function App() {
  const status = useSession((s) => s.status);
  const init = useSession((s) => s.init);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined);
  const [helpOpen, setHelpOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState('');
  const view = useMail((s) => s.view);
  const online = useMail((s) => s.online);
  const selectedId = useMail((s) => s.selectedId);
  const layout = useSession((s) => s.settings.layout);
  const toasts = useToasts((s) => s.toasts);
  const wsConnected = useWebSocket(status === 'ready');

  useEffect(() => { void init(); }, [init]);

  useEffect(() => {
    if (status === 'ready') {
      void useMail.getState().boot();
      void useCompose.getState().loadIdentities();
    }
  }, [status]);

  // unread badge in tab title
  const unread = useMail((s) => s.mailboxes.find((m) => m.id === 'u:inbox')?.unreadEmails ?? 0);
  useEffect(() => {
    document.title = unread > 0 ? `Inbox (${unread}) - Seamless` : 'Seamless';
  }, [unread]);

  if (status === 'loading') return null;
  if (status !== 'ready') return <Login />;

  const runSearch = () => {
    const q = search.trim();
    if (q) useMail.getState().setView({ kind: 'search', query: q, title: `Search: ${q}` });
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <button className="icon-btn mobile-only" style={{ display: 'none' }} onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Menu"><MenuIcon /></button>
          <MailLogo size="1.65em" />Seamless
        </div>
        <div className="search">
          <SearchIcon aria-hidden />
          <input
            placeholder="Search mail  (from:  to:  label:  is:unread  has:attachment)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch();
              if (e.key === 'Escape') { setSearch(''); if (view.kind === 'search') useMail.getState().setView({ kind: 'mailbox', mailboxId: 'u:inbox', title: 'Inbox' }); }
            }}
          />
          {search && <button className="icon-btn" onClick={() => setSearch('')} aria-label="Clear"><CloseIcon /></button>}
        </div>
        <div className="spacer" />
        <span className={`conn-dot ${wsConnected && online ? '' : 'offline'}`} title={wsConnected && online ? 'Live' : 'Offline / reconnecting'} />
        <button className="icon-btn" title="Help" onClick={() => setHelpOpen(true)}><HelpIcon /></button>
        <button className="icon-btn" title="Settings" onClick={() => { setSettingsTab(undefined); setSettingsOpen(true); }}><SettingsIcon /></button>
      </header>
      <div className={`main ${layout === 'table' ? 'table-mode' : ''} ${selectedId ? 'reading' : ''}`}>
        <Sidebar open={sidebarOpen} onNavigate={() => setSidebarOpen(false)} />
        <MessageList />
        <ReadingPane />
      </div>
      <ComposeDock />
      <GettingStarted openSettings={(tab) => { setSettingsTab(tab); setSettingsOpen(true); }} openHelp={() => setHelpOpen(true)} />
      {settingsOpen && <Suspense fallback={null}><Settings initialTab={settingsTab} onClose={() => setSettingsOpen(false)} /></Suspense>}
      {helpOpen && <Suspense fallback={null}><HelpModal onClose={() => setHelpOpen(false)} /></Suspense>}
      <div className="toast-wrap">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </div>
  );
}
