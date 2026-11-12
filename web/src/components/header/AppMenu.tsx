/** The menu at the far top-right: check mail now, Settings, Log out (they used to live in the sidebar footer). */
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';
import { navigate } from '../../router.ts';
import { useSession } from '../../state/session.ts';
import { MenuIcon, RedoIcon, SettingsIcon, LogoutIcon, KeyboardIcon, HelpIcon, SunIcon, MoonIcon, SystemIcon } from '../../icons.tsx';
import { useUi } from '../../state/ui.ts';

export default function AppMenu() {
  const [open, setOpen] = useState(false);
  const [fetching, setFetching] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const mode = useSession((x) => x.settings.mode);
  const saveSettings = useSession((x) => x.saveSettings);
  const go = (fn: () => void) => () => { setOpen(false); fn(); };

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
        onClick={() => setOpen((v) => !v)}><MenuIcon size={20} /></button>
      {open && (
        <div className="dropdown app-menu-pop" role="menu">
          <button className="side-item" role="menuitem" disabled={fetching} onClick={() => void fetchAll()}>
            <RedoIcon size={17} weight="bold" className={fetching ? 'spin' : ''} /><span className="name">Check New Mail</span>
          </button>
          <div className="menu-sep" />
          <button className="side-item" role="menuitem" onClick={go(() => navigate({ page: 'settings', tab: 'general' }))}>
            <SettingsIcon size={17} /><span className="name">Settings</span>
          </button>
          <div className="menu-sep" />
          <div className="side-item menu-theme" role="group" aria-label="Colour mode">
            <SunIcon size={17} /><span className="name">Theme</span>
            <span className="seg menu-seg">
              {([['light', 'Light', SunIcon], ['dark', 'Dark', MoonIcon], ['system', 'Match system', SystemIcon]] as const).map(([v, label, Icon]) => (
                <button key={v} className={`seg-btn ${mode === v ? 'on' : ''}`} title={label} aria-label={label} aria-pressed={mode === v}
                  onClick={() => void saveSettings({ mode: v })}><Icon size={15} /></button>
              ))}
            </span>
          </div>
          <button className="side-item" role="menuitem" onClick={go(() => useUi.getState().set({ shortcutsOpen: true }))}>
            <KeyboardIcon size={17} /><span className="name">Keyboard shortcuts</span>
          </button>
          <button className="side-item" role="menuitem" onClick={go(() => useUi.getState().set({ helpPage: null, helpOpen: true }))}>
            <HelpIcon size={17} /><span className="name">Help &amp; manual</span>
          </button>
          <div className="menu-sep" />
          <button className="side-item" role="menuitem" onClick={go(() => void useSession.getState().logout())}>
            <LogoutIcon size={17} /><span className="name">Log out</span>
          </button>
        </div>
      )}
    </div>
  );
}
