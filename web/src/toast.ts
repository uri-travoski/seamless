import { create } from 'zustand';

export interface Toast { id: number; text: string; kind: 'info' | 'error' }

let id = 0;

export const useToasts = create<{ toasts: Toast[]; push: (text: string, kind?: Toast['kind']) => void; dismiss: (id: number) => void }>((set, get) => ({
  toasts: [],
  push: (text, kind = 'info') => {
    const t = { id: ++id, text, kind };
    set({ toasts: [...get().toasts, t] });
    setTimeout(() => get().dismiss(t.id), kind === 'error' ? 6000 : 3500);
  },
  dismiss: (tid) => set({ toasts: get().toasts.filter((t) => t.id !== tid) }),
}));

export const toast = (text: string, kind: Toast['kind'] = 'info') => useToasts.getState().push(text, kind);
