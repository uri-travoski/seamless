/** Saved searches / smart views (T4 F-34): the list, 30 s-cached counts and the one-time suggestions. */
import { create } from 'zustand';
import type { ApiSavedView, ApiViewSuggestion } from '@seamless/shared';
import { api } from '../api/client.ts';

export interface ViewDraft { id?: number; name: string; query: string; scope: string; icon: string; color: string | null; pinned: boolean; showCount: boolean; notify: boolean }

interface ViewsState {
  views: ApiSavedView[];
  counts: Record<string, number>;
  suggestions: ApiViewSuggestion[];
  editing: ViewDraft | null;               // the Save/Edit dialog
  load: () => Promise<void>;
  loadCounts: () => Promise<void>;
  save: (d: ViewDraft) => Promise<void>;
  remove: (id: number) => Promise<void>;
  addSuggestion: (s: ApiViewSuggestion) => Promise<void>;
  dismissSuggestions: () => Promise<void>;
  openSave: (query: string, scope: string) => void;
  openEdit: (v: ApiSavedView) => void;
  close: () => void;
}

export const VIEW_ICONS = ['magnifying-glass', 'star', 'hourglass', 'warning', 'paperclip', 'receipt', 'envelope-simple', 'tag'] as const;

let defaultsAsked = false;
export const useViews = create<ViewsState>((set, get) => ({
  views: [], counts: {}, suggestions: [], editing: null,
  load: async () => {
    try {
      if (!defaultsAsked) { defaultsAsked = true; await api.post('/api/views/defaults'); }
      const [views, suggestions] = await Promise.all([
        api.get<ApiSavedView[]>('/api/views'), api.get<ApiViewSuggestion[]>('/api/views/suggestions')]);
      set({ views, suggestions });
      await get().loadCounts();
    } catch { /* signed out or offline */ }
  },
  loadCounts: async () => {
    try { set({ counts: await api.get<Record<string, number>>('/api/views/counts') }); } catch { /* keep old */ }
  },
  save: async (d) => {
    const body = { name: d.name, query: d.query, scope: d.scope, icon: d.icon, color: d.color, pinned: d.pinned, showCount: d.showCount, notify: d.notify };
    if (d.id) await api.put(`/api/views/${d.id}`, body); else await api.post('/api/views', body);
    set({ editing: null });
    await get().load();
  },
  remove: async (id) => { await api.del(`/api/views/${id}`); set({ editing: null }); await get().load(); },
  addSuggestion: async (s) => {
    await api.post('/api/views', { name: s.name, query: s.query, icon: s.icon });
    await get().load();
  },
  dismissSuggestions: async () => { await api.post('/api/views/suggestions/dismiss'); set({ suggestions: [] }); },
  openSave: (query, scope) => set({ editing: { name: '', query, scope, icon: 'magnifying-glass', color: null, pinned: true, showCount: true, notify: false } }),
  openEdit: (v) => set({ editing: { id: v.id, name: v.name, query: v.query, scope: v.scope, icon: v.icon, color: v.color, pinned: v.pinned, showCount: v.showCount, notify: v.notify } }),
  close: () => set({ editing: null }),
}));
