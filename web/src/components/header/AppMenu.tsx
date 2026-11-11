/** The menu at the far top-right: check mail now, Settings, Log out (they used to live in the sidebar footer). */
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';
import { navigate } from '../../router.ts';
import { useSession } from '../../state/session.ts';
import { MenuIcon, RedoIcon, SettingsIcon, LogoutIcon } from '../../icons.tsx';

export default function AppMenu() {
  const [open, setOpen] = useState(false);
  const [fetching, setFetching] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const fetchAll = async () => {
    setOpen(false);
    if (fetching) return;
    setFetching(true);
    try {
      const res = await api.post<{ accounts: number }>('/api/sync');
      toast(res.accounts ? `Checking ${res.accounts} mailbox${res.accounts === 1 ? '' : 'es'} for new mail…` : 'No connected mailboxes to check');
    } catch (e: any) {
      toast(e?.message ?? 'Could not check for mail', 'error');
    } finally {
      setFetching(false);
    }
  };

  return (
    <div className="app-menu" ref={ref}>
      <button className={`icon-btn menu-btn ${open ? 'active' : ''}`} aria-haspopup="menu" aria-expanded={open} aria-label="Menu" title="Menu"
        onClick={() => setOpen((v) => !v)}><MenuIcon /></button>
      {open && (
        <div className="dropdown app-menu-pop" role="menu">
          <button className="side-item" role="menuitem" disabled={fetching} onClick={() => void fetchAll()}>
            <RedoIcon size={17} weight="bold" className={fetching ? 'spin' : ''} /><span className="name">Check all mailboxes for new mail</span>
          </button>
          <button className="side-item" role="menuitem" onClick={() => { setOpen(false); navigate({ page: 'settings', tab: 'general' }); }}>
            <SettingsIcon size={17} /><span className="name">Settings</span>
          </button>
          <div className="menu-sep" />
          <button className="side-item" role="menuitem" onClick={() => { setOpen(false); void useSession.getState().logout(); }}>
            <LogoutIcon size={17} /><span className="name">Log out</span>
          </button>
        </div>
      )}
    </div>
  );
}
