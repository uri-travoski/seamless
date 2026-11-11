import { create } from 'zustand';

export interface ToastAction { label: string; run: () => void }
export interface Toast { id: number; text: string; kind: 'info' | 'error'; action?: ToastAction }

let id = 0;

export const useToasts = create<{ toasts: Toast[]; push: (text: string, kind?: Toast['kind'], action?: ToastAction) => number; dismiss: (id: number) => void }>((set, get) => ({
  toasts: [],
  push: (text, kind = 'info', action) => {
    const t = { id: ++id, text, kind, action };
    set({ toasts: [...get().toasts, t] });
    // undo toasts live 5 s (T1 F-16); errors linger a little longer
    setTimeout(() => get().dismiss(t.id), action ? 5000 : kind === 'error' ? 6000 : 3500);
    return t.id;
  },
  dismiss: (tid) => set({ toasts: get().toasts.filter((t) => t.id !== tid) }),
}));

export const toast = (text: string, kind: Toast['kind'] = 'info') => useToasts.getState().push(text, kind);

/** A toast with an Undo button (5 s). */
export const undoToast = (text: string, undo: () => void) =>
  useToasts.getState().push(text, 'info', { label: 'Undo', run: undo });
