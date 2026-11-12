/** Critical alerts (T8.9): red, pinned above ordinary notifications until fixed or marked read one by one. */
import { create } from 'zustand';
import { api } from '../api/client.ts';

export interface AlertDelivery { channelId: number; ok: boolean; at: number; error?: string; message: 'open' | 'reminder' | 'recovered'; name: string; kind: string }
export interface AppAlert {
  id: number; kind: string; title: string; body: string; link: string | null; accountId: number | null;
  state: 'open' | 'resolved'; read: boolean; openedAt: number; resolvedAt: number | null;
  sendCount: number; lastSentAt: number | null; deliveries: AlertDelivery[];
}
export interface AlertStatus { active: number; open: number; hasChannel: boolean }

interface AlertState {
  items: AppAlert[];
  status: AlertStatus;
  refresh: () => Promise<void>;
  markRead: (id: number) => Promise<void>;
}

export const useAlerts = create<AlertState>((set, get) => ({
  items: [],
  status: { active: 0, open: 0, hasChannel: true },
  refresh: async () => {
    try { const r = await api.get<{ items: AppAlert[]; status: AlertStatus }>('/api/alerts/summary'); set({ items: r.items, status: r.status }); } catch { /* offline */ }
  },
  markRead: async (id) => {
    set({ items: get().items.filter((a) => a.id !== id), status: { ...get().status, active: Math.max(0, get().status.active - 1) } });
    try { await api.post('/api/alerts/read', { ids: [id] }); } catch { /* refreshed below */ }
    void get().refresh();
  },
}));
