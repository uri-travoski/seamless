import { create } from 'zustand';

export interface ToastAction { label: string; run: () => void }
export interface Toast { id: number; text: string; kind: 'info' | 'error'; action?: ToastAction }

let id = 0;

export const useToasts = create<{
  toasts: Toast[];
  push: (text: string, kind?: Toast['kind'], action?: ToastAction, ms?: number) => number;
  setText: (id: number, text: string) => void;
  dismiss: (id: number) => void;
}>((set, get) => ({
  toasts: [],
  push: (text, kind = 'info', action, ms) => {
    const t = { id: ++id, text, kind, action };
    set({ toasts: [...get().toasts, t] });
    // undo toasts live 5 s (T1 F-16); errors linger a little longer
    setTimeout(() => get().dismiss(t.id), ms ?? (action ? 5000 : kind === 'error' ? 6000 : 3500));
    return t.id;
  },
  setText: (tid, text) => set({ toasts: get().toasts.map((t) => (t.id === tid ? { ...t, text } : t)) }),
  dismiss: (tid) => set({ toasts: get().toasts.filter((t) => t.id !== tid) }),
}));

export const toast = (text: string, kind: Toast['kind'] = 'info') => useToasts.getState().push(text, kind);

/** A toast with an Undo button (5 s). */
export const undoToast = (text: string, undo: () => void) =>
  useToasts.getState().push(text, 'info', { label: 'Undo', run: undo });

/** "Sending in 10s… Undo": counts down until `releaseAt`, then goes away. Returns a stop function. */
export function countdownToast(label: (secs: number) => string, releaseAt: number, undo: () => void): () => void {
  const secsLeft = () => Math.max(0, Math.ceil((releaseAt - Date.now()) / 1000));
  const id = useToasts.getState().push(label(secsLeft()), 'info', { label: 'Undo', run: undo }, Math.max(0, releaseAt - Date.now()) + 400);
  const timer = setInterval(() => {
    if (!useToasts.getState().toasts.some((t) => t.id === id)) { clearInterval(timer); return; }
    useToasts.getState().setText(id, label(secsLeft()));
  }, 250);
  return () => { clearInterval(timer); useToasts.getState().dismiss(id); };
}
