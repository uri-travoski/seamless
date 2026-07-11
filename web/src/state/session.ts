import { create } from 'zustand';
import { api } from '../api/client.ts';
import type { ApiUser } from '@seamless/shared';

export interface ClientSettings {
  fontSize: number;
  fontFamily: string;               // Google font family name, '' = system default
  density: 'compact' | 'comfortable';
  layout: 'split' | 'table';
  allowRemoteImages: boolean;
  trackByDefault: boolean;
}

const DEFAULTS: ClientSettings = { fontSize: 15, fontFamily: '', density: 'comfortable', layout: 'split', allowRemoteImages: false, trackByDefault: false };

const SYSTEM_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

interface SessionState {
  status: 'loading' | 'setup' | 'login' | 'ready';
  user: ApiUser | null;
  settings: ClientSettings;
  init: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  setup: (email: string, name: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  saveSettings: (patch: Partial<ClientSettings>) => void;
}

function applyFontSize(px: number): void {
  const root = document.documentElement.style;
  root.setProperty('--md-font-content', `${px}px`);
  // scale the whole UI (sidebar, list, toolbars) relative to the default of 15
  root.setProperty('--md-scale', String(px / 15));
}

/** Load a Google font by family name and apply it app-wide via the --md-font var. */
function applyFontFamily(family: string): void {
  const root = document.documentElement.style;
  const id = 'md-google-font';
  document.getElementById(id)?.remove();
  const trimmed = family.trim();
  if (!trimmed) {
    root.setProperty('--md-font', SYSTEM_STACK);
    return;
  }
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(trimmed).replace(/%20/g, '+')}:wght@400;500;600;700&display=swap`;
  document.head.appendChild(link);
  root.setProperty('--md-font', `'${trimmed.replace(/'/g, '')}', ${SYSTEM_STACK}`);
}

function applyAppearance(s: ClientSettings): void {
  applyFontSize(s.fontSize);
  applyFontFamily(s.fontFamily);
}

export const useSession = create<SessionState>((set, get) => ({
  status: 'loading',
  user: null,
  settings: DEFAULTS,

  init: async () => {
    try {
      const me = await api.get<{ needsSetup: boolean; loggedIn: boolean; user?: ApiUser | null; settings: Partial<ClientSettings> }>('/api/me');
      const settings = { ...DEFAULTS, ...me.settings };
      applyAppearance(settings);
      set({
        status: me.needsSetup ? 'setup' : me.loggedIn ? 'ready' : 'login',
        user: me.user ?? null,
        settings,
      });
    } catch {
      set({ status: 'login' });
    }
  },

  login: async (email, password) => {
    await api.post('/api/login', { email, password });
    await get().init();
  },

  setup: async (email, name, password) => {
    await api.post('/api/setup', { email, name, password });
    await get().init();
  },

  logout: async () => {
    await api.post('/api/logout');
    set({ status: 'login', user: null });
  },

  saveSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    applyAppearance(settings);
    set({ settings });
    void api.put('/api/settings', settings).catch(() => {});
  },
}));

window.addEventListener('md-unauthorized', () => {
  const s = useSession.getState();
  if (s.status === 'ready') useSession.setState({ status: 'login' });
});
