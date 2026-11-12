/** Empty search result: "Older mail may be in an archive" with a button that searches the archive indexes (T8.5). */
import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { navigate } from '../router.ts';

interface Hit { key: string; archiveId: number; archiveName: string; date: number; subject: string; from: { name: string; addr: string } }

export default function ArchiveHint({ query }: { query: string }) {
  const [has, setHas] = useState(false);
  const [res, setRes] = useState<{ total: number; results: Hit[] } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setRes(null);
    let live = true;
    api.get<{ archives: { status: string }[] }>('/api/archives').then((r) => { if (live) setHas(r.archives.some((a) => a.status === 'done')); }).catch(() => {});
    return () => { live = false; };
  }, [query]);
  if (!has) return null;
  const search = async () => {
    setBusy(true);
    try { setRes(await api.get(`/api/archives/search?${new URLSearchParams({ q: query })}`)); } catch { setRes({ total: 0, results: [] }); }
    setBusy(false);
  };
  return (
    <div className="archive-hint" role="note">
      <p>Older mail may be in an archive.</p>
      <button className="btn" disabled={busy} onClick={() => void search()}>Search archives</button>
      {res && (res.total === 0 ? <p className="dim">Nothing in your archives matches either.</p> : (
        <>
          <p className="dim">{res.total.toLocaleString()} found in your archives.</p>
          <ul className="health-list">
            {res.results.slice(0, 20).map((h) => (
              <li key={`${h.archiveId}-${h.key}`}>{new Date(h.date).toLocaleDateString()} — {h.from.name || h.from.addr}: {h.subject || '(no subject)'} <a href={`/api/archives/${h.archiveId}/messages/${h.key}/eml`} download>.eml</a></li>
            ))}
          </ul>
          <button className="linklike" onClick={() => navigate({ page: 'settings', tab: 'backup' })}>Restore from Settings → Backup</button>
        </>
      ))}
    </div>
  );
}
