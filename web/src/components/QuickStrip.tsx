/** One scrolling row above the message list: quick filters (All / Unread / Attachments), smart views, then Leads. */
import { useEffect, useState } from 'react';
import { useMail, scopeToSlug } from '../state/mail.ts';
import { useViews } from '../state/views.ts';
import { useRouter, navigate } from '../router.ts';
import { api } from '../api/client.ts';
import { ViewGlyph } from './viewIcons.tsx';
import { PencilSimple, UserPlus } from '@phosphor-icons/react';

export default function QuickStrip({ view, unread }: { view: { quick?: any }; unread: number }) {
  const route = useRouter((s) => s.route);
  const overview = useMail((s) => s.overview);
  const views = useViews((s) => s.views);
  const counts = useViews((s) => s.counts);
  const pinned = views.filter((v) => v.pinned);
  const [newLeads, setNewLeads] = useState(0);
  useEffect(() => { void useViews.getState().load(); }, [overview]);
  useEffect(() => { api.get<{ total: number }>('/api/leads?status=new&limit=1').then((r) => setNewLeads(r.total)).catch(() => {}); }, [overview]);

  const open = (v: { query: string; scope: string }) => navigate({ page: 'mail', scope: scopeToSlug(v.scope, overview), folder: 'search', q: v.query });
  const active = (v: { query: string; scope: string }) =>
    route.page === 'mail' && route.folder === 'search' && route.q === v.query && route.scope === scopeToSlug(v.scope, overview);

  return (
    <div className="quick-strip" role="group" aria-label="Quick filters and smart views">
      {([[undefined, 'All'], ['unread', 'Unread'], ['attach', 'Attachments']] as const).map(([q, name]) => (
        <button key={name} className={`quick-pill ${view.quick === q ? 'on' : ''}`}
          onClick={() => useMail.getState().setView({ ...(view as any), quick: q })}>{name}{q === 'unread' && unread > 0 ? ` (${unread})` : ''}</button>
      ))}
      {pinned.length > 0 && <span className="strip-sep" aria-hidden="true" />}
      {pinned.map((v) => (
        <span key={v.id} className={`quick-pill view-pill ${active(v) ? 'on' : ''}`}>
          <button className="view-pill-open" onClick={() => open(v)} title={v.query}>
            <ViewGlyph icon={v.icon} className="glyph" />{v.name}
            {v.showCount && counts[String(v.id)] !== undefined && <span className="pill-count">{counts[String(v.id)]}</span>}
          </button>
          {active(v) && <button className="view-pill-edit" aria-label={`Edit ${v.name}`} title="Edit this view" onClick={() => useViews.getState().openEdit(v)}><PencilSimple size={12} /></button>}
        </span>
      ))}
      <span className="strip-sep" aria-hidden="true" />
      <button className={`quick-pill ${route.page === 'leads' ? 'on' : ''}`} onClick={() => navigate({ page: 'leads', params: {} })} title="Leads captured from web forms">
        <UserPlus size={14} className="glyph" />Leads{newLeads > 0 && <span className="pill-count">{newLeads}</span>}
      </button>
    </div>
  );
}
