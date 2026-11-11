import { create } from 'zustand';
import type { ApiNotification } from '@seamless/shared';
import { api } from '../api/client.ts';

interface NotifState {
  unread: number;
  latest: ApiNotification[];
  sound: boolean;
  refresh: () => Promise<void>;
  markRead: (ids: number[] | 'all') => Promise<void>;
  loadPrefs: () => Promise<void>;
}

/** A short two-tone chime (WebAudio, no asset to load). */
function chime(): void {
  try {
    const ctx = new AudioContext();
    const t = ctx.currentTime;
    for (const [i, f] of [880, 1320].entries()) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.08, t + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.25);
      o.connect(g).connect(ctx.destination);
      o.start(t + i * 0.12);
      o.stop(t + i * 0.12 + 0.3);
    }
    setTimeout(() => void ctx.close(), 800);
  } catch { /* no audio */ }
}

export const useNotifs = create<NotifState>((set, get) => ({
  unread: 0,
  latest: [],
  sound: false,

  refresh: async () => {
    try {
      const prev = get().unread;
      const s = await api.get<{ unread: number; latest: ApiNotification[] }>('/api/notifications/summary');
      set({ unread: s.unread, latest: s.latest });
      if (get().sound && s.unread > prev && prev >= 0) chime();
    } catch { /* offline */ }
  },

  markRead: async (ids) => {
    const latest = get().latest.map((n) => (ids === 'all' || ids.includes(n.id) ? { ...n, read: true } : n));
    const delta = ids === 'all' ? get().unread : get().latest.filter((n) => ids.includes(n.id) && !n.read).length;
    set({ latest, unread: Math.max(0, get().unread - delta) });
    try { await api.post('/api/notifications/read', ids === 'all' ? { all: true } : { ids }); } catch { void get().refresh(); }
  },

  loadPrefs: async () => {
    try { set({ sound: !!(await api.get<{ sound: boolean }>('/api/notification-prefs')).sound }); } catch { /* default off */ }
  },
}));

export function relTime(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)}d`;
  return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
}
