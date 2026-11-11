import { create } from 'zustand';
import { api } from '../api/client.ts';
import type { ApiUser } from '@seamless/shared';
import { applyAppearance as applyTheme } from '../theme/apply.ts';
import { DEFAULT_THEME } from '../theme/registry.ts';

export interface ClientSettings {
  fontSize: number;
  fontFamily: string;               // Google font family name, '' = system default
  density: 'compact' | 'comfortable';
  layout: 'split' | 'table';
  allowRemoteImages: boolean;
  trackByDefault: boolean;
  theme: string;                    // theme registry id ("seamless" = the original look)
  mode: 'light' | 'dark' | 'system';
  accent: string;                   // '' = the theme's own accent
  appName: string;                  // shown in the header/sidebar and the tab title
  shortcuts: boolean;               // Gmail-style keyboard shortcuts
  lastScope: string;                // 'unified' | 'category:<id>' | 'account:<id>'
  noTrackDomains: string[];         // never insert the tracking pixel for these recipient domains
  perRecipientTracking: boolean;    // default for the compose window's per-recipient toggle
  sidebar: SidebarConfig;           // order of system folders; the rest live under "More"
  labelSort: 'az' | 'manual' | 'count';
  sidebarCollapsed: boolean;
}

export interface SidebarConfig { order: string[]; more: string[] }

export const SIDEBAR_FOLDERS = ['inbox', 'starred', 'drafts', 'scheduled', 'sent', 'templates', 'spam', 'bin', 'archive', 'snoozed'];
export const DEFAULT_SIDEBAR: SidebarConfig = {
  order: ['inbox', 'starred', 'drafts', 'scheduled', 'sent', 'templates', 'spam', 'bin'],
  more: ['snoozed', 'archive'],
};

const DEFAULTS: ClientSettings = {
  fontSize: 15, fontFamily: '', density: 'comfortable', layout: 'split', allowRemoteImages: false,
  trackByDefault: true, theme: DEFAULT_THEME, mode: 'light', accent: '', appName: 'Seamless',
  shortcuts: true, lastScope: 'unified', noTrackDomains: [], perRecipientTracking: false,
  sidebar: DEFAULT_SIDEBAR, labelSort: 'az', sidebarCollapsed: false,
};

const APPEARANCE_CACHE = 'seamless-appearance';

/** Paint in the user's theme before /api/me answers (and on the login screen). */
export function applyCachedAppearance(): void {
  let cached: Partial<ClientSettings> = {};
  try { cached = JSON.parse(localStorage.getItem(APPEARANCE_CACHE) ?? '{}'); } catch { /* none */ }
  const s = { ...DEFAULTS, ...cached };
  applyTheme({ theme: s.theme, mode: s.mode, accent: s.accent, density: s.density });
}

const SYSTEM_STACK = 'var(--font-sans)';

interface SessionState {
  status: 'loading' | 'setup' | 'login' | 'ready';
  user: ApiUser | null;
  settings: ClientSettings;
  init: () => Promise<void>;
  /** Resolves to an MFA token when a second factor is required (no session yet). */
  login: (email: string, password: string) => Promise<{ mfaToken?: string }>;
  loginMfa: (mfaToken: string, code: string) => Promise<{ usedRecoveryCode: boolean }>;
  mfaEnrollRequired: boolean;
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
    root.removeProperty('--md-font');   // fall back to the theme's own font
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
  applyTheme({ theme: s.theme, mode: s.mode, accent: s.accent, density: s.density });
  applyFontSize(s.fontSize);
  applyFontFamily(s.fontFamily);
  try {
    localStorage.setItem(APPEARANCE_CACHE, JSON.stringify({ theme: s.theme, mode: s.mode, accent: s.accent, density: s.density, appName: s.appName }));
  } catch { /* storage blocked: fine, the server copy wins after login */ }
}

export function cachedAppName(): string {
  try { return JSON.parse(localStorage.getItem(APPEARANCE_CACHE) ?? '{}').appName || DEFAULTS.appName; } catch { return DEFAULTS.appName; }
}

export const useSession = create<SessionState>((set, get) => ({
  status: 'loading',
  user: null,
  settings: DEFAULTS,

  init: async () => {
    try {
      const me = await api.get<{ needsSetup: boolean; loggedIn: boolean; user?: ApiUser | null; settings: Partial<ClientSettings>; mfaEnrollRequired?: boolean }>('/api/me');
      const settings = { ...DEFAULTS, ...me.settings };
      applyAppearance(settings);
      set({
        status: me.needsSetup ? 'setup' : me.loggedIn ? 'ready' : 'login',
        user: me.user ?? null,
        settings,
        mfaEnrollRequired: !!me.mfaEnrollRequired,
      });
    } catch {
      set({ status: 'login' });
    }
  },

  login: async (email, password) => {
    const r = await api.post<{ ok: boolean; mfaRequired?: boolean; mfaToken?: string }>('/api/login', { email, password });
    if (r.mfaRequired) return { mfaToken: r.mfaToken };
    await get().init();
    return {};
  },

  loginMfa: async (mfaToken, code) => {
    const r = await api.post<{ ok: boolean; usedRecoveryCode?: boolean }>('/api/login/mfa', { mfaToken, code });
    await get().init();
    return { usedRecoveryCode: !!r.usedRecoveryCode };
  },
  mfaEnrollRequired: false,

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
