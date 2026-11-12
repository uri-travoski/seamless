/** Settings → Backup / Storage: "Archive old mail" (T8.5). The rule form, a live preview, the monthly rule and the list of archives. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';
import { formatBytes } from '../Sidebar.tsx';
import { navigate } from '../../router.ts';

interface Preview { count: number; bytes: number; oldest: number | null; newest: number | null; olderThanDays: number }
interface Archive {
  id: number; name: string; olderThanDays: number; scope: string; mode: 'copy' | 'move'; status: string; messageCount: number; byteCount: number;
  createdAt: number; finishedAt: number | null; error: string | null; progress: number; restoreResult: { expected: number; restored: number; alreadyPresent: number; failed: number } | null;
}
interface Schedule { enabled: boolean; olderThanDays: number; nextDueAt: number | null; lastRunAt: number | null }
interface Hit { key: string; date: number; subject: string; from: { name: string; addr: string }; accountEmail: string }

const YEARS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const DAY = 86_400_000;
const when = (t: number | null) => (t ? new Date(t).toLocaleDateString([], { dateStyle: 'medium' }) : '—');
const ACTIVE = ['planned', 'running', 'verifying', 'restoring'];
const STATUS: Record<string, string> = { planned: 'Waiting to start', running: 'Copying', verifying: 'Checking', restoring: 'Restoring', done: 'Finished', failed: 'Failed' };

/** "Archive mail older than [3] years" → whole days (years = 365 days, months = 30), the same rule the server uses. */
export function ruleDays(sel: string, otherN: number, otherUnit: 'months' | 'years'): number {
  if (sel !== 'other') return Number(sel) * 365;
  return Math.round(otherN * (otherUnit === 'years' ? 365 : 30));
}
export function previewText(p: Preview | null): string {
  if (!p) return 'Counting…';
  if (!p.count) return 'Nothing matches this rule.';
  const y = (t: number | null) => (t ? new Date(t).getFullYear() : '');
  const span = y(p.oldest) === y(p.newest) ? `in ${y(p.oldest)}` : `from ${y(p.oldest)} to ${y(p.newest)}`;
  return `${p.count.toLocaleString()} message${p.count === 1 ? '' : 's'}, ${formatBytes(p.bytes)}, ${span}`;
}

export default function ArchiveSettings() {
  const [sel, setSel] = useState('3');
  const [otherN, setOtherN] = useState(18);
  const [otherUnit, setOtherUnit] = useState<'months' | 'years'>('months');
  const [scope, setScope] = useState('all');
  const [accounts, setAccounts] = useState<{ id: number; email: string }[]>([]);
  const [targets, setTargets] = useState<{ id: number; name: string }[]>([]);
  const [targetId, setTargetId] = useState(0);
  const [mode, setMode] = useState<'copy' | 'move'>('copy');
  const [keepStarred, setKeepStarred] = useState(true);
  const [keepVip, setKeepVip] = useState(true);
  const [spamBin, setSpamBin] = useState(false);
  const [alsoServer, setAlsoServer] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [sample, setSample] = useState<{ id: number; subject: string; from: string; date: number }[] | null>(null);
  const [confirm, setConfirm] = useState<null | 'run'>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [archives, setArchives] = useState<Archive[]>([]);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [open, setOpen] = useState<{ id: number; kind: 'browse' | 'restore' | 'delete' } | null>(null);
  const [error, setError] = useState('');

  const days = ruleDays(sel, otherN, otherUnit);
  const validDays = Number.isFinite(days) && days >= 1;
  const options = useMemo(() => ({ includeStarred: !keepStarred, includeVip: !keepVip, includeSpamBin: spamBin, alsoDeleteFromServer: mode === 'move' && alsoServer }), [keepStarred, keepVip, spamBin, alsoServer, mode]);
  const qs = useMemo(() => new URLSearchParams({ olderThanDays: String(days), scope, includeStarred: String(!keepStarred), includeVip: String(!keepVip), includeSpamBin: String(spamBin) }).toString(), [days, scope, keepStarred, keepVip, spamBin]);

  const loadList = useCallback(async () => {
    const r = await api.get<{ archives: Archive[] }>('/api/archives');
    setArchives(r.archives);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [a, t, s] = await Promise.all([
          api.get<any>('/api/accounts'), api.get<{ targets: { id: number; name: string }[] }>('/api/archives/targets'), api.get<{ schedule: Schedule }>('/api/archives/schedule'),
        ]);
        setAccounts((a.accounts ?? a ?? []).map((x: any) => ({ id: x.id, email: x.email })));
        setTargets(t.targets); setTargetId((cur) => cur || t.targets[0]?.id || 0);
        setSchedule(s.schedule);
        await loadList();
      } catch (e: any) { setError(e?.message ?? 'Could not load'); }
    })();
  }, [loadList]);

  // live preview: re-count a moment after the last change
  useEffect(() => {
    setSample(null);
    if (!validDays) { setPreview(null); return; }
    setPreview(null);
    const t = setTimeout(() => { api.get<Preview>(`/api/archives/preview?${qs}`).then(setPreview).catch((e) => setError(e?.message ?? '')); }, 250);
    return () => clearTimeout(t);
  }, [qs, validDays]);

  // keep the list fresh while something runs
  const anyActive = archives.some((a) => ACTIVE.includes(a.status));
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!anyActive) return;
    timer.current = setInterval(() => { void loadList().catch(() => {}); }, 3000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [anyActive, loadList]);

  const body = () => ({ olderThanDays: days, scope, mode, targetId, options });

  const dryRun = async () => {
    setBusy(true);
    try { const r = await api.post<{ sample: any[] } & Preview>('/api/archives', { ...body(), dryRun: true }); setPreview(r); setSample(r.sample); }
    catch (e: any) { toast(e?.message ?? 'Dry run failed', 'error'); }
    setBusy(false);
  };
  const runNow = async () => {
    setBusy(true);
    try {
      await api.post('/api/archives', body());
      toast('Archive started'); setConfirm(null); setTyped(''); await loadList();
    } catch (e: any) { toast(e?.message ?? 'Could not start', 'error'); }
    setBusy(false);
  };
  const saveSchedule = async (enabled: boolean) => {
    try {
      const r = await api.put<{ schedule: Schedule }>('/api/archives/schedule', { enabled, ...body() });
      setSchedule(r.schedule);
      toast(enabled ? 'Monthly archive is on' : 'Monthly archive is off');
    } catch (e: any) { toast(e?.message ?? 'Could not save', 'error'); }
  };

  const noTarget = targets.length === 0;
  const canRun = validDays && !noTarget && !!targetId && !!preview?.count;
  const ruleText = `older than ${sel === 'other' ? `${otherN} ${otherUnit}` : `${sel} year${sel === '1' ? '' : 's'}`}`;

  return (
    <section className="archive-card" aria-labelledby="archive-h">
      <h3 id="archive-h">Archive old mail</h3>
      <p className="settings-desc">
        Copy mail you rarely need to a backup storage target as plain <code>.eml</code> files with a searchable index. Nothing is lost: you can browse, search and bring any of it back.
      </p>
      {error && <div className="health-note" role="alert">{error}</div>}

      <div className="field-row">
        <div className="field">
          <label htmlFor="arch-years">Archive mail older than</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <select id="arch-years" value={sel} onChange={(e) => setSel(e.target.value)}>
              {YEARS.map((y) => <option key={y} value={y}>{y} year{y === 1 ? '' : 's'}</option>)}
              <option value="other">Other…</option>
            </select>
            {sel === 'other' && (
              <>
                <input type="number" min={1} max={1200} aria-label="Amount" value={otherN} onChange={(e) => setOtherN(Number(e.target.value))} style={{ width: 80 }} />
                <select aria-label="Unit" value={otherUnit} onChange={(e) => setOtherUnit(e.target.value as any)}>
                  <option value="months">months</option><option value="years">years</option>
                </select>
              </>
            )}
          </div>
        </div>
        <div className="field">
          <label htmlFor="arch-scope">Which mailboxes</label>
          <select id="arch-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">All of mine</option>
            {accounts.map((a) => <option key={a.id} value={`account:${a.id}`}>{a.email}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="arch-target">Where to</label>
          {noTarget
            ? <div className="hint">No backup storage yet. <button className="linklike" onClick={() => navigate({ page: 'settings', tab: 'storage' })}>Set one up in Settings → Storage</button> (an administrator does this).</div>
            : <select id="arch-target" value={targetId} onChange={(e) => setTargetId(Number(e.target.value))}>{targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}
        </div>
      </div>

      <fieldset className="field" style={{ border: 'none', padding: 0 }}>
        <legend style={{ fontSize: 12, fontWeight: 600 }}>What to do</legend>
        <label><input type="radio" name="arch-mode" checked={mode === 'copy'} onChange={() => setMode('copy')} /> Copy only — everything stays in the app</label>
        <label><input type="radio" name="arch-mode" checked={mode === 'move'} onChange={() => setMode('move')} /> Move — copy, check every file, then remove from the app. Mail stays on the mail server unless you tick the box below.</label>
        {mode === 'move' && <label style={{ marginLeft: 22 }}><input type="checkbox" checked={alsoServer} onChange={(e) => setAlsoServer(e.target.checked)} /> also move it to the Bin on the mail server</label>}
      </fieldset>
      <div className="field">
        <label><input type="checkbox" checked={keepStarred} onChange={(e) => setKeepStarred(e.target.checked)} /> Keep starred mail in the app</label>
        <label><input type="checkbox" checked={keepVip} onChange={(e) => setKeepVip(e.target.checked)} /> Keep mail from VIP senders in the app</label>
        <label><input type="checkbox" checked={spamBin} onChange={(e) => setSpamBin(e.target.checked)} /> Include Spam and Bin</label>
      </div>

      <div className="archive-preview" role="status" aria-live="polite"><strong>{validDays ? previewText(preview) : 'Enter a number of months or years.'}</strong></div>

      <div className="field" style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
        <button className="btn" disabled={!canRun || busy} onClick={() => void dryRun()}>Dry run</button>
        <button className="btn primary" disabled={!canRun || busy} onClick={() => { setConfirm('run'); setTyped(''); }}>Run now</button>
      </div>
      {sample && (
        <div className="health-note" style={{ marginBottom: 12 }}>
          <strong>Dry run — nothing was copied.</strong> {previewText(preview)}. The oldest {sample.length}:
          <ul className="health-list">{sample.map((s) => <li key={s.id}>{when(s.date)} — {s.from}: {s.subject || '(no subject)'}</li>)}</ul>
        </div>
      )}
      {confirm && preview && (
        <div className="archive-confirm" role="dialog" aria-label="Confirm archive">
          <p><strong>{mode === 'move' ? 'Move' : 'Copy'} {preview.count.toLocaleString()} messages ({formatBytes(preview.bytes)}) {ruleText}?</strong></p>
          <p className="hint">
            {mode === 'move'
              ? 'Each message is copied, read back and checked first. Only then is it removed from this app. You can restore it later from the list below.'
              : 'Everything stays in the app; a copy goes to the storage target.'}
          </p>
          {mode === 'move' && (
            <div className="field"><label htmlFor="arch-move">Type MOVE to confirm</label><input id="arch-move" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></div>
          )}
          <button className="btn primary" disabled={busy || (mode === 'move' && typed !== 'MOVE')} onClick={() => void runNow()}>{mode === 'move' ? 'Move mail' : 'Start copying'}</button>{' '}
          <button className="btn ghost" onClick={() => setConfirm(null)}>Cancel</button>
        </div>
      )}

      <h4>Every month</h4>
      <div className="field">
        <label>
          <input type="checkbox" checked={!!schedule?.enabled} disabled={noTarget || !validDays} onChange={(e) => void saveSchedule(e.target.checked)} />
          {' '}Each month, archive anything {ruleText} using the choices above
        </label>
        <span className="hint">
          {schedule?.enabled
            ? `Next run ${when(schedule.nextDueAt)}${schedule.lastRunAt ? `, last run ${when(schedule.lastRunAt)}` : ''}. You get a notification when it finishes. Changed the choices? ` : 'You get a notification when each run finishes. '}
          {schedule?.enabled && <button className="linklike" onClick={() => void saveSchedule(true)}>Save them to the monthly rule</button>}
        </span>
      </div>

      <h4>Archives</h4>
      {archives.length === 0 ? <p className="dim">No archives yet.</p> : (
        <table className="tbl archive-list">
          <thead><tr><th>Date</th><th>Rule</th><th>Messages</th><th>Size</th><th>Status</th><th /></tr></thead>
          <tbody>
            {archives.map((a) => (
              <ArchiveRowView key={a.id} a={a} open={open?.id === a.id ? open.kind : null} setOpen={(k) => setOpen(k ? { id: a.id, kind: k } : null)} reload={loadList} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ArchiveRowView({ a, open, setOpen, reload }: { a: Archive; open: 'browse' | 'restore' | 'delete' | null; setOpen: (k: 'browse' | 'restore' | 'delete' | null) => void; reload: () => Promise<void> }) {
  const busy = ACTIVE.includes(a.status);
  const pct = Math.round(a.progress * 100);
  return (
    <>
      <tr>
        <td>{when(a.createdAt)}<div className="dim">{a.name}</div></td>
        <td>{a.mode === 'move' ? 'Move' : 'Copy'}, older than {a.olderThanDays % 365 === 0 ? `${a.olderThanDays / 365} y` : `${a.olderThanDays} days`}</td>
        <td>{a.messageCount.toLocaleString()}</td>
        <td>{formatBytes(a.byteCount)}</td>
        <td style={{ minWidth: 150 }}>
          {STATUS[a.status] ?? a.status}
          {busy && <progress value={pct} max={100} aria-label={`${pct}% done`} style={{ width: '100%' }} />}
          {a.error && <div className="health-note">{a.error}</div>}
          {a.restoreResult && <div className="health-note">Restored {a.restoreResult.restored.toLocaleString()} of {a.restoreResult.expected.toLocaleString()}{a.restoreResult.alreadyPresent ? ` (${a.restoreResult.alreadyPresent} were already here)` : ''}</div>}
        </td>
        <td style={{ whiteSpace: 'nowrap' }}>
          <button className="btn ghost" disabled={a.status !== 'done'} onClick={() => setOpen(open === 'browse' ? null : 'browse')}>Browse / search</button>
          <button className="btn ghost" disabled={a.status !== 'done'} onClick={() => setOpen(open === 'restore' ? null : 'restore')}>Restore…</button>
          <button className="btn ghost danger" disabled={busy} onClick={() => setOpen(open === 'delete' ? null : 'delete')}>Delete…</button>
        </td>
      </tr>
      {open && <tr><td colSpan={6}>
        {open === 'browse' && <Browse a={a} />}
        {open === 'restore' && <Restore a={a} done={() => { setOpen(null); void reload(); }} />}
        {open === 'delete' && <Delete a={a} done={() => { setOpen(null); void reload(); }} />}
      </td></tr>}
    </>
  );
}

function Browse({ a }: { a: Archive }) {
  const [text, setText] = useState('');
  const [res, setRes] = useState<{ total: number; results: Hit[] } | null>(null);
  const go = useCallback(async (v: string) => {
    try { setRes(await api.get(`/api/archives/${a.id}/search?${new URLSearchParams({ q: v, limit: '50' })}`)); } catch (e: any) { toast(e?.message ?? 'Search failed', 'error'); }
  }, [a.id]);
  useEffect(() => { void go(''); }, [go]);
  return (
    <div>
      <form onSubmit={(e) => { e.preventDefault(); void go(text); }} style={{ display: 'flex', gap: 8 }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Subject, sender or words from the preview" aria-label={`Search ${a.name}`} style={{ flex: 1 }} />
        <button className="btn" type="submit">Search</button>
      </form>
      {res && <p className="dim">{res.total.toLocaleString()} found{res.total > res.results.length ? `, showing the newest ${res.results.length}` : ''}.</p>}
      <ul className="health-list">
        {res?.results.map((h) => (
          <li key={h.key}>{when(h.date)} — {h.from.name || h.from.addr}: {h.subject || '(no subject)'}{' '}
            <a href={`/api/archives/${a.id}/messages/${h.key}/eml`} download>Download .eml</a></li>
        ))}
      </ul>
    </div>
  );
}

function Restore({ a, done }: { a: Archive; done: () => void }) {
  const [how, setHow] = useState<'all' | 'range' | 'search'>('all');
  const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const b: any = {};
      if (how === 'range') { if (from) b.from = new Date(from).getTime(); if (to) b.to = new Date(to).getTime() + DAY - 1; }
      if (how === 'search') b.q = text;
      await api.post(`/api/archives/${a.id}/restore`, b);
      toast('Restore started'); done();
    } catch (e: any) { toast(e?.message ?? 'Could not restore', 'error'); }
    setBusy(false);
  };
  return (
    <div>
      <p className="hint">Restored mail goes back into its original mailbox and looks like normal mail. Mail that is already there is skipped.</p>
      <label><input type="radio" name={`rs${a.id}`} checked={how === 'all'} onChange={() => setHow('all')} /> Everything in this archive</label>{' '}
      <label><input type="radio" name={`rs${a.id}`} checked={how === 'range'} onChange={() => setHow('range')} /> A date range</label>{' '}
      <label><input type="radio" name={`rs${a.id}`} checked={how === 'search'} onChange={() => setHow('search')} /> Messages matching a search</label>
      {how === 'range' && <div className="field-row"><input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} /><input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} /></div>}
      {how === 'search' && <div className="field"><input aria-label="Search words" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. invoice or ann@example.com" /></div>}
      <div><button className="btn primary" disabled={busy || (how === 'search' && !text.trim())} onClick={() => void go()}>Restore</button></div>
    </div>
  );
}

function Delete({ a, done }: { a: Archive; done: () => void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await api.del(`/api/archives/${a.id}`, { confirm: a.name }); toast('Archive deleted'); done(); }
    catch (e: any) { toast(e?.message ?? 'Could not delete', 'error'); }
    setBusy(false);
  };
  return (
    <div>
      <p className="hint">This removes the archive's files from the storage target. If it was a Move, that mail is then gone from this app too (it may still be on the mail server). Type <strong>{a.name}</strong> to confirm.</p>
      <div className="field"><input aria-label="Archive name" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></div>
      <button className="btn danger" disabled={busy || typed !== a.name} onClick={() => void go()}>Delete archive</button>
    </div>
  );
}
