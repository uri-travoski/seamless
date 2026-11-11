import { create } from 'zustand';
import type { ApiEmail, ApiLabel, ApiMailbox, EmailQueryFilter, ApiCategoryOverview, ScopeId } from '@seamless/shared';
import { api, fetchMailboxes, queryEmailPage, getEmailsByIds, getThread, emailSet } from '../api/client.ts';
import { cache } from '../api/cache.ts';

export const PAGE = 120;

export interface View {
  kind: 'mailbox' | 'label' | 'search' | 'review';
  mailboxId?: string;
  labelId?: number;
  query?: string;
  title: string;
}

function baseFilter(view: View): EmailQueryFilter {
  if (view.kind === 'mailbox') return { inMailbox: view.mailboxId };
  if (view.kind === 'label') return { label: view.labelId };
  if (view.kind === 'review') return { needsReview: true };
  return { text: view.query ?? '' };
}

/** The list filter for a view inside the current scope (T1 F-07). */
export function viewFilter(view: View, scope: ScopeId = useMail.getState().scope): EmailQueryFilter {
  const f = baseFilter(view);
  return scope && scope !== 'unified' ? { ...f, scope } : f;
}

function viewKey(view: View, scope: ScopeId = useMail.getState().scope): string {
  return JSON.stringify(viewFilter(view, scope));
}

// ---- scope <-> URL slug ----

export function scopeToSlug(scope: ScopeId, overview: ApiCategoryOverview | null): string {
  const m = scope.match(/^(category|account):(\d+)$/);
  if (!m) return 'unified';
  if (m[1] === 'account') return `mb-${m[2]}`;
  return overview?.categories.find((c) => c.id === Number(m[2]))?.key ?? 'unified';
}

export function slugToScope(slug: string, overview: ApiCategoryOverview | null): ScopeId | null {
  if (!slug || slug === 'unified') return 'unified';
  const mb = slug.match(/^mb-(\d+)$/);
  if (mb) return `account:${mb[1]}`;
  const cat = overview?.categories.find((c) => c.key === slug);
  return cat ? `category:${cat.id}` : null;
}

export function scopeName(scope: ScopeId, overview: ApiCategoryOverview | null): string {
  const m = scope.match(/^(category|account):(\d+)$/);
  if (!m) return 'Unified';
  if (m[1] === 'account') {
    const mb = overview?.mailboxes.find((x) => x.id === Number(m[2]));
    return mb ? (mb.name || mb.email) : 'Mailbox';
  }
  return overview?.categories.find((c) => c.id === Number(m[2]))?.name ?? 'Category';
}

interface MailState {
  scope: ScopeId;                   // unified | category:<id> | account:<id>
  overview: ApiCategoryOverview | null;
  allMatching: boolean;             // bulk bar: "select all N matching" (server-side)
  mailboxes: ApiMailbox[];
  labels: ApiLabel[];
  reviewCount: number;
  view: View;
  total: number;
  ids: string[];                    // sparse: ids[i] may be undefined until page loads
  emails: Record<string, ApiEmail>;
  loadedPages: Set<number>;
  loadingPages: Set<number>;
  selectedId: string | null;
  threadIds: string[];
  online: boolean;
  checked: Set<string>;             // ids selected via row checkboxes for bulk actions

  boot: () => Promise<void>;
  setScope: (scope: ScopeId) => void;
  /** Apply a route: scope + view together (one fetch, not two). */
  show: (scope: ScopeId, view: View) => void;
  refreshCategories: () => Promise<void>;
  setAllMatching: (on: boolean) => void;
  refreshMailboxes: () => Promise<void>;
  refreshLabels: () => Promise<void>;
  setView: (view: View) => void;
  loadPage: (page: number) => Promise<void>;
  refreshCurrent: () => Promise<void>;
  select: (id: string | null) => Promise<void>;
  patchEmail: (id: string, patch: Partial<ApiEmail>) => void;

  markRead: (id: string, read: boolean) => void;
  toggleStar: (id: string) => void;
  moveTo: (id: string, target: string) => void;
  destroy: (id: string) => void;
  applyLabels: (id: string, labelIds: number[]) => void;

  toggleChecked: (id: string, on?: boolean) => void;
  setAllChecked: (on: boolean) => void;
  clearChecked: () => void;
  bulkMarkRead: (read: boolean) => void;
  bulkMove: (target: string) => void;
  bulkDestroy: () => void;
  bulkAddLabel: (labelId: number) => void;
}

export const useMail = create<MailState>((set, get) => ({
  scope: 'unified',
  overview: null,
  allMatching: false,
  mailboxes: [],
  labels: [],
  reviewCount: 0,
  view: { kind: 'mailbox', mailboxId: 'u:inbox', title: 'Inbox' },
  total: 0,
  ids: [],
  emails: {},
  loadedPages: new Set(),
  loadingPages: new Set(),
  selectedId: null,
  threadIds: [],
  online: true,
  checked: new Set(),

  boot: async () => {
    // instant paint from cache, then network truth
    const [cachedBoxes, cachedQuery] = await Promise.all([
      cache.getMailboxes(),
      cache.getQuery(viewKey(get().view)),
    ]);
    if (cachedBoxes) set({ mailboxes: cachedBoxes });
    if (cachedQuery) {
      const cachedEmails = await cache.getEmails(cachedQuery.ids);
      const emails: Record<string, ApiEmail> = {};
      for (const e of cachedEmails) if (e) emails[e.id] = e;
      set({ ids: cachedQuery.ids, total: cachedQuery.total, emails, loadedPages: new Set([0]) });
    }
    await Promise.all([get().refreshCategories(), get().refreshMailboxes(), get().refreshLabels(), get().refreshCurrent()]);
  },

  /** Switch Unified ⇄ category ⇄ single mailbox. Same folder, new account set. */
  setScope: (scope) => {
    if (scope === get().scope) return;
    set({ scope });
    void get().refreshMailboxes();
    void get().refreshLabels();
    get().setView({ ...get().view });
  },

  show: (scope, view) => {
    const scopeChanged = scope !== get().scope;
    if (scopeChanged) set({ scope });
    if (scopeChanged || viewKey(view, scope) !== viewKey(get().view, scope)) get().setView(view);
    else if (view.title !== get().view.title) set({ view });
    if (scopeChanged) { void get().refreshMailboxes(); void get().refreshLabels(); }
  },

  refreshCategories: async () => {
    try { set({ overview: await api.get<ApiCategoryOverview>('/api/categories') }); } catch { /* offline */ }
  },

  setAllMatching: (on) => set({ allMatching: on }),

  refreshMailboxes: async () => {
    try {
      const mailboxes = await fetchMailboxes(get().scope);
      set({ mailboxes, online: true });
      void cache.putMailboxes(mailboxes);
      void api.get<{ count: number }>('/api/review/count').then((r) => set({ reviewCount: r.count })).catch(() => {});
      void get().refreshCategories();
    } catch {
      set({ online: false });
    }
  },

  refreshLabels: async () => {
    try {
      const scope = get().scope;
      const labels = await api.get<ApiLabel[]>(`/api/labels${scope !== 'unified' ? `?scope=${encodeURIComponent(scope)}` : ''}`);
      set({ labels });
    } catch { /* offline */ }
  },

  setView: (view) => {
    set({ view, ids: [], total: 0, loadedPages: new Set(), loadingPages: new Set(), selectedId: null, threadIds: [], checked: new Set(), allMatching: false });
    // cached page 0 first for instant switch
    void cache.getQuery(viewKey(view)).then(async (cached) => {
      if (!cached || viewKey(get().view) !== viewKey(view)) return;
      const cachedEmails = await cache.getEmails(cached.ids);
      if (viewKey(get().view) !== viewKey(view) || get().loadedPages.size > 0) return;
      const emails = { ...get().emails };
      for (const e of cachedEmails) if (e) emails[e.id] = e;
      set({ ids: cached.ids, total: cached.total, emails });
    });
    void get().loadPage(0);
  },

  loadPage: async (page) => {
    const state = get();
    if (state.loadedPages.has(page) || state.loadingPages.has(page)) return;
    const view = state.view;
    set({ loadingPages: new Set(state.loadingPages).add(page) });
    try {
      const { query, emails } = await queryEmailPage(viewFilter(view), page * PAGE, PAGE);
      if (viewKey(get().view) !== viewKey(view)) return;
      const cur = get();
      const ids = [...cur.ids];
      ids.length = query.total;
      query.ids.forEach((id, i) => { ids[page * PAGE + i] = id; });
      const emailMap = { ...cur.emails };
      for (const e of emails) emailMap[e.id] = e;
      set({
        ids, total: query.total, emails: emailMap, online: true,
        loadedPages: new Set(cur.loadedPages).add(page),
      });
      if (page === 0) {
        void cache.putQuery(viewKey(view), { ids: query.ids, total: query.total, state: query.queryState, ts: Date.now() });
        void cache.putEmails(emails);
      }
    } catch {
      set({ online: false });
    } finally {
      const lp = new Set(get().loadingPages);
      lp.delete(page);
      set({ loadingPages: lp });
    }
  },

  refreshCurrent: async () => {
    const state = get();
    const view = state.view;
    const pages = state.loadedPages.size > 0 ? [...state.loadedPages] : [0];
    try {
      for (const page of pages.sort((a, b) => a - b)) {
        const { query, emails } = await queryEmailPage(viewFilter(view), page * PAGE, PAGE);
        if (viewKey(get().view) !== viewKey(view)) return;
        const cur = get();
        const ids = page === pages[0] ? new Array(query.total) : [...cur.ids];
        ids.length = query.total;
        query.ids.forEach((id, i) => { ids[page * PAGE + i] = id; });
        const emailMap = { ...cur.emails };
        for (const e of emails) emailMap[e.id] = e;
        set({ ids, total: query.total, emails: emailMap, online: true, loadedPages: new Set(pages.slice(0, pages.indexOf(page) + 1)) });
        if (page === 0) {
          void cache.putQuery(viewKey(view), { ids: query.ids, total: query.total, state: query.queryState, ts: Date.now() });
          void cache.putEmails(emails);
        }
      }
      await Promise.all([get().refreshMailboxes(), get().refreshLabels()]);
      // refresh open thread + selected email
      const sel = get().selectedId;
      if (sel && get().emails[sel]) {
        const threadIds = await getThread(get().emails[sel].threadId);
        const fresh = await getEmailsByIds(threadIds);
        const emailMap = { ...get().emails };
        for (const e of fresh) emailMap[e.id] = e;
        set({ threadIds, emails: emailMap });
      }
    } catch {
      set({ online: false });
    }
  },

  select: async (id) => {
    if (!id) { set({ selectedId: null, threadIds: [] }); return; }
    const email = get().emails[id];
    set({ selectedId: id, threadIds: email ? [id] : [] });
    if (email && email.keywords.$seen !== true) get().markRead(id, true);
    if (email) {
      try {
        const threadIds = await getThread(email.threadId);
        if (get().selectedId !== id) return;
        const missing = threadIds.filter((tid) => !get().emails[tid]);
        if (missing.length) {
          const fetched = await getEmailsByIds(missing);
          const emailMap = { ...get().emails };
          for (const e of fetched) emailMap[e.id] = e;
          set({ emails: emailMap });
        }
        set({ threadIds });
      } catch { /* offline: single message view */ }
    }
  },

  patchEmail: (id, patch) => {
    const email = get().emails[id];
    if (!email) return;
    set({ emails: { ...get().emails, [id]: { ...email, ...patch } } });
  },

  markRead: (id, read) => {
    const email = get().emails[id];
    if (!email) return;
    get().patchEmail(id, { keywords: { ...email.keywords, $seen: read } });
    // optimistic unread count on mailboxes
    set({
      mailboxes: get().mailboxes.map((mb) =>
        mb.id === email.mailboxId || (mb.role && mb.role === email.mailboxRole && mb.accountId === null)
          ? { ...mb, unreadEmails: Math.max(0, mb.unreadEmails + (read ? -1 : 1)) }
          : mb),
    });
    void emailSet({ [id]: { 'keywords/$seen': read } }).catch(() => get().refreshCurrent());
  },

  toggleStar: (id) => {
    const email = get().emails[id];
    if (!email) return;
    const on = !email.keywords.$flagged;
    get().patchEmail(id, { keywords: { ...email.keywords, $flagged: on } });
    void emailSet({ [id]: { 'keywords/$flagged': on } }).catch(() => get().refreshCurrent());
  },

  moveTo: (id, target) => {
    const state = get();
    set({
      ids: state.ids.filter((x) => x !== id),
      total: Math.max(0, state.total - 1),
      selectedId: state.selectedId === id ? null : state.selectedId,
      threadIds: state.selectedId === id ? [] : state.threadIds,
    });
    void emailSet({ [id]: { mailboxIds: { [target]: true } } })
      .then(() => get().refreshMailboxes())
      .catch(() => get().refreshCurrent());
  },

  destroy: (id) => {
    const state = get();
    set({
      ids: state.ids.filter((x) => x !== id),
      total: Math.max(0, state.total - 1),
      selectedId: state.selectedId === id ? null : state.selectedId,
      threadIds: state.selectedId === id ? [] : state.threadIds,
    });
    void emailSet({}, [id]).then(() => get().refreshMailboxes()).catch(() => get().refreshCurrent());
  },

  applyLabels: (id, labelIds) => {
    get().patchEmail(id, { labelIds });
    void emailSet({ [id]: { labelIds } }).catch(() => get().refreshCurrent());
  },

  // ---- multi-select / bulk actions ----

  toggleChecked: (id, on) => {
    const next = new Set(get().checked);
    const shouldCheck = on ?? !next.has(id);
    if (shouldCheck) next.add(id); else next.delete(id);
    set({ checked: next });
  },

  setAllChecked: (on) => {
    if (!on) { set({ checked: new Set(), allMatching: false }); return; }
    set({ checked: new Set(get().ids.filter(Boolean)) });
  },

  clearChecked: () => set({ checked: new Set(), allMatching: false }),

  bulkMarkRead: (read) => {
    const ids = [...get().checked];
    const update: Record<string, Record<string, unknown>> = {};
    for (const id of ids) {
      const email = get().emails[id];
      if (email) get().patchEmail(id, { keywords: { ...email.keywords, $seen: read } });
      update[id] = { 'keywords/$seen': read };
    }
    // optimistic unread counts on the current mailbox rows
    set({
      mailboxes: get().mailboxes.map((mb) => {
        const delta = ids.filter((id) => {
          const e = get().emails[id];
          return e && (mb.id === e.mailboxId || (mb.accountId === null && mb.role === e.mailboxRole));
        }).length;
        return delta ? { ...mb, unreadEmails: Math.max(0, mb.unreadEmails + (read ? -delta : delta)) } : mb;
      }),
      checked: new Set(),
    });
    if (ids.length) void emailSet(update).catch(() => get().refreshCurrent());
  },

  bulkMove: (target) => {
    const ids = new Set(get().checked);
    if (ids.size === 0) return;
    const state = get();
    const update: Record<string, Record<string, unknown>> = {};
    for (const id of ids) update[id] = { mailboxIds: { [target]: true } };
    set({
      ids: state.ids.filter((x) => !ids.has(x)),
      total: Math.max(0, state.total - ids.size),
      selectedId: state.selectedId && ids.has(state.selectedId) ? null : state.selectedId,
      checked: new Set(),
    });
    void emailSet(update).then(() => get().refreshMailboxes()).catch(() => get().refreshCurrent());
  },

  bulkDestroy: () => {
    const ids = new Set(get().checked);
    if (ids.size === 0) return;
    const state = get();
    set({
      ids: state.ids.filter((x) => !ids.has(x)),
      total: Math.max(0, state.total - ids.size),
      selectedId: state.selectedId && ids.has(state.selectedId) ? null : state.selectedId,
      checked: new Set(),
    });
    void emailSet({}, [...ids]).then(() => get().refreshMailboxes()).catch(() => get().refreshCurrent());
  },

  bulkAddLabel: (labelId) => {
    const ids = [...get().checked];
    const update: Record<string, Record<string, unknown>> = {};
    for (const id of ids) {
      const email = get().emails[id];
      if (!email) continue;
      const labelIds = email.labelIds.includes(labelId) ? email.labelIds : [...email.labelIds, labelId];
      get().patchEmail(id, { labelIds });
      update[id] = { labelIds };
    }
    set({ checked: new Set() });
    if (Object.keys(update).length) void emailSet(update).catch(() => get().refreshCurrent());
  },
}));
