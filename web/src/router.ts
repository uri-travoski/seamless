/**
 * Tiny history router (T0 AD-6 / T1 F-08). The URL is the source of truth for which page
 * shows and which scope/folder the mail view is on, so a reload or a notification deep
 * link lands in the same place.
 *
 *   /mail/<scope>/<folder>              scope = unified | <category key> | mb-<accountId>
 *   /mail/<scope>/label/<id>            folder = inbox starred drafts scheduled sent templates
 *   /mail/<scope>/folder/<mailboxId>             spam bin archive review search
 *   /mail/<scope>/search?q=...
 *   /mail/msg/<emailId>                 open one message (from a notification)
 *   /mail/msg/<emailId>/opens           open report
 *   /notifications?status=&types=&...
 *   /leads?business=&status=&service=&tab=stats&lead=<id>
 *   /settings/<tab>
 */
import { create } from 'zustand';

export type Route =
  | { page: 'mail'; scope: string; folder: string; arg?: string; q?: string }
  | { page: 'message'; emailId: string }
  | { page: 'opens'; emailId: string }
  | { page: 'notifications'; params: Record<string, string> }
  | { page: 'leads'; params: Record<string, string> }
  | { page: 'settings'; tab: string };

export function parsePath(pathname: string, search: string): Route {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const qs = Object.fromEntries(new URLSearchParams(search));
  if (parts[0] === 'settings') return { page: 'settings', tab: parts[1] || 'general' };
  if (parts[0] === 'notifications') return { page: 'notifications', params: qs };
  if (parts[0] === 'leads') return { page: 'leads', params: qs };
  if (parts[0] === 'mail' && parts[1] === 'msg' && parts[2]) {
    return parts[3] === 'opens' ? { page: 'opens', emailId: parts[2] } : { page: 'message', emailId: parts[2] };
  }
  if (parts[0] === 'mail') {
    const scope = parts[1] || 'unified';
    const folder = parts[2] || 'inbox';
    if (folder === 'label' || folder === 'folder') return { page: 'mail', scope, folder, arg: parts[3] };
    if (folder === 'search') return { page: 'mail', scope, folder, q: qs.q ?? '' };
    return { page: 'mail', scope, folder };
  }
  return { page: 'mail', scope: '', folder: 'inbox' };      // "" = use the remembered scope
}

export function routePath(r: Route): string {
  switch (r.page) {
    case 'settings': return `/settings/${r.tab}`;
    case 'notifications': {
      const qs = new URLSearchParams(Object.entries(r.params).filter(([, v]) => v !== '' && v != null)).toString();
      return `/notifications${qs ? `?${qs}` : ''}`;
    }
    case 'leads': {
      const qs = new URLSearchParams(Object.entries(r.params).filter(([, v]) => v !== '' && v != null)).toString();
      return `/leads${qs ? `?${qs}` : ''}`;
    }
    case 'message': return `/mail/msg/${r.emailId}`;
    case 'opens': return `/mail/msg/${r.emailId}/opens`;
    case 'mail': {
      const base = `/mail/${encodeURIComponent(r.scope || 'unified')}/${r.folder}`;
      if (r.folder === 'label' || r.folder === 'folder') return `${base}/${r.arg ?? ''}`;
      if (r.folder === 'search') return `${base}?q=${encodeURIComponent(r.q ?? '')}`;
      return base;
    }
  }
}

interface RouterState {
  route: Route;
  navigate: (to: Route | string, opts?: { replace?: boolean }) => void;
}

export const useRouter = create<RouterState>((set) => ({
  route: parsePath(location.pathname, location.search),
  navigate: (to, opts) => {
    const path = typeof to === 'string' ? to : routePath(to);
    const url = new URL(path, location.origin);
    if (url.pathname + url.search !== location.pathname + location.search) {
      if (opts?.replace) history.replaceState(null, '', path); else history.pushState(null, '', path);
    }
    set({ route: parsePath(url.pathname, url.search) });
  },
}));

window.addEventListener('popstate', () => {
  useRouter.setState({ route: parsePath(location.pathname, location.search) });
});

export const navigate = (to: Route | string, opts?: { replace?: boolean }) => useRouter.getState().navigate(to, opts);

/** Folder slug → what the mail list shows. */
export const FOLDER_ROLE: Record<string, string> = {
  inbox: 'inbox', drafts: 'drafts', scheduled: 'scheduled', sent: 'sent', archive: 'archive', spam: 'junk', bin: 'trash',
};
export const ROLE_FOLDER: Record<string, string> = Object.fromEntries(Object.entries(FOLDER_ROLE).map(([k, v]) => [v, k]));
export const FOLDER_TITLE: Record<string, string> = {
  inbox: 'Inbox', starred: 'Starred', drafts: 'Drafts', scheduled: 'Scheduled', sent: 'Sent', templates: 'Templates',
  spam: 'Spam', bin: 'Bin', archive: 'Archive', review: 'Review', search: 'Search', snoozed: 'Snoozed', readlater: 'Read later', waiting: 'Waiting for reply', assigned: 'Assigned to me', unassigned: 'Unassigned',
};
