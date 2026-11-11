/** Shared-inbox client state (T4 F-32): presence over the WebSocket, assignments, comments. */
import { create } from 'zustand';
import type { ApiAssignment, ApiThreadComment, WsMessage } from '@seamless/shared';
import { api } from '../api/client.ts';
import { useMail } from './mail.ts';

const PRESENCE_TTL = 60_000;
interface PresenceEntry { userId: number; userName: string; action: 'replying' | 'viewing'; ts: number }

interface SharedState {
  presence: Record<string, PresenceEntry[]>;       // `${accountId}:${threadId}`
  ownedShared: number[];                           // my mailboxes that I have shared out
  loadedOwned: boolean;
  onPresence: (m: WsMessage) => void;
  loadOwned: () => Promise<void>;
}

export const useShared = create<SharedState>((set, get) => ({
  presence: {}, ownedShared: [], loadedOwned: false,
  onPresence: (m) => {
    if (m.type !== 'presence' || !m.threadId || m.accountId == null || m.userId == null) return;
    const key = `${m.accountId}:${m.threadId}`;
    const rest = (get().presence[key] ?? []).filter((e) => e.userId !== m.userId);
    if (m.action && m.action !== 'left') rest.push({ userId: m.userId, userName: m.userName ?? 'Someone', action: m.action, ts: Date.now() });
    set({ presence: { ...get().presence, [key]: rest } });
  },
  loadOwned: async () => {
    try {
      const r = await api.get<{ owned: { accountId: number; shares: unknown[] }[] }>('/api/shares');
      set({ ownedShared: r.owned.filter((o) => o.shares.length > 0).map((o) => o.accountId), loadedOwned: true });
    } catch { set({ loadedOwned: true }); }
  },
}));

/** Entries still fresh (not refreshed in 60 s = gone). */
export function livePresence(entries: PresenceEntry[] | undefined, now = Date.now()): PresenceEntry[] {
  return (entries ?? []).filter((e) => now - e.ts < PRESENCE_TTL);
}

let socket: WebSocket | null = null;
export function setSocket(ws: WebSocket | null) { socket = ws; }
export function sendPresence(threadId: string, accountId: number, action: 'replying' | 'viewing' | 'left') {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'presence', threadId, accountId, action }));
}

/** Is this mailbox shared in either direction (I own and share it, or it is shared with me)? */
export function isSharedAccount(accountId: number): boolean {
  const ov = useMail.getState().overview;
  return !!ov?.shared?.some((s) => s.id === accountId) || useShared.getState().ownedShared.includes(accountId);
}

export const fetchAssignment = (accountId: number, threadId: string) =>
  api.get<ApiAssignment>(`/api/threads/${encodeURIComponent(threadId)}/assignment?accountId=${accountId}`);
export const saveAssignment = (accountId: number, threadId: string, body: { assigneeId: number | null; status: string; dueAt?: number | null }) =>
  api.put<ApiAssignment>(`/api/threads/${encodeURIComponent(threadId)}/assignment`, { accountId, ...body });
export const fetchComments = (accountId: number, threadId: string) =>
  api.get<ApiThreadComment[]>(`/api/threads/${encodeURIComponent(threadId)}/comments?accountId=${accountId}`);
export const postComment = (accountId: number, threadId: string, body: string) =>
  api.post<ApiThreadComment>(`/api/threads/${encodeURIComponent(threadId)}/comments`, { accountId, body });
export const fetchPeople = (accountId: number) =>
  api.get<{ id: number; name: string; email: string; role: string }[]>(`/api/accounts/${accountId}/people`);
