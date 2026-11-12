import { useState } from 'react';
import { toast } from '../../toast.ts';

interface Report {
  preview: boolean; kind: string; flavor?: string; headers?: string[]; mapping?: Record<string, string[]>;
  total: number; created: number; merged: number; duplicates: number; invalid: number; skipped: number; groupsCreated: string[];
  skippedRows: { row: number; reason: string; name: string; email: string }[];
  sample: { name: string; emails: string[]; phones: string[]; org: string; groups: string[]; status: string }[];
}
type Mode = 'skip' | 'merge' | 'fill';

const SLOTS: { role: string; label: string; n: number }[] = [
  { role: 'name', label: 'Full name', n: 1 }, { role: 'first', label: 'First name', n: 1 }, { role: 'last', label: 'Last name', n: 1 },
  { role: 'email', label: 'Email', n: 3 }, { role: 'phone', label: 'Phone', n: 2 },
  { role: 'org', label: 'Organisation', n: 1 }, { role: 'notes', label: 'Notes', n: 1 }, { role: 'groups', label: 'Groups / labels', n: 1 },
];

const csvEscape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Import wizard: choose a file → preview (counts + column mapping for CSV) → choose duplicate handling → result. */
export default function ContactImport({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<Mode>('merge');
  const [mapping, setMapping] = useState<Record<string, string[]> | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);

  const call = async (f: File, preview: boolean, m: Mode, map: Record<string, string[]> | null): Promise<Report | null> => {
    const fd = new FormData();
    fd.append('file', f);
    const qs = new URLSearchParams({ mode: m });
    if (preview) qs.set('preview', '1');
    if (map) qs.set('mapping', JSON.stringify(map));
    const res = await fetch(`/api/contacts/import?${qs}`, { method: 'POST', body: fd, credentials: 'same-origin' });
    if (!res.ok) { toast('Could not read that file', 'error'); return null; }
    return res.json();
  };

  const choose = async (f: File) => {
    setFile(f); setBusy(true);
    const r = await call(f, true, mode, null);
    setBusy(false);
    if (r) { setReport(r); setMapping(r.mapping ?? null); }
  };
  const repreview = async (map: Record<string, string[]>, m: Mode = mode) => {
    if (!file) return;
    setMapping(map); setBusy(true);
    const r = await call(file, true, m, map);
    setBusy(false);
    if (r) setReport({ ...r, headers: report?.headers ?? r.headers });
  };
  const doImport = async () => {
    if (!file) return;
    setBusy(true);
    const r = await call(file, false, mode, report?.kind === 'csv' ? mapping : null);
    setBusy(false);
    if (r) { setReport(r); toast(`Imported: ${r.created} new, ${r.merged} updated`); onDone(); }
  };
  const downloadSkipped = () => {
    const rows = [['row', 'reason', 'name', 'email'], ...(report?.skippedRows ?? []).map((r) => [String(r.row), r.reason, r.name, r.email])];
    const url = URL.createObjectURL(new Blob([rows.map((r) => r.map(csvEscape).join(',')).join('\r\n')], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = 'skipped-contacts.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const done = report && !report.preview;
  const setSlot = (role: string, i: number, col: string, n: number) => {
    const cur = [...(mapping?.[role] ?? [])];
    while (cur.length < n) cur.push('');
    cur[i] = col;
    void repreview({ ...(mapping ?? {}), [role]: cur.filter(Boolean) });
  };

  return (
    <div className="contact-drawer" role="dialog" aria-label="Import contacts">
      <h3 style={{ marginTop: 0 }}>Import contacts</h3>
      {!file && (
        <>
          <p className="settings-desc">Choose a <b>.vcf</b> (Apple, Android, Outlook, Thunderbird) or a <b>.csv</b> (Google Contacts, Outlook, Apple/Thunderbird, or any spreadsheet). UTF-8 and UTF-16, comma or semicolon.</p>
          <input type="file" accept=".vcf,.csv,.json,text/vcard,text/csv,application/json" onChange={(e) => { const f = e.target.files?.[0]; if (f) void choose(f); }} />
        </>
      )}
      {file && report && (
        <>
          <p style={{ margin: '4px 0' }}>
            <b>{file.name}</b> · {report.kind.toUpperCase()}{report.flavor && report.flavor !== 'generic' ? ` (${report.flavor})` : ''} · {report.total} rows
          </p>
          <p style={{ margin: '4px 0' }}>
            <b>{report.created}</b> {done ? 'created' : 'new'} · <b>{done ? report.merged : report.duplicates}</b> {done ? 'updated' : 'already in your contacts'} · <b>{report.invalid}</b> invalid
            {report.groupsCreated.length > 0 && <> · groups {done ? 'created' : 'to create'}: {report.groupsCreated.join(', ')}</>}
          </p>

          {!done && report.kind === 'csv' && report.headers && (
            <details open={!(mapping?.email?.length)} style={{ margin: '8px 0' }}>
              <summary>Column mapping {!(mapping?.email?.length) && <span style={{ color: 'var(--color-warning)' }}>— choose the email column</span>}</summary>
              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px', marginTop: 6, alignItems: 'center' }}>
                {SLOTS.map((s) => Array.from({ length: s.n }, (_, i) => (
                  <label key={`${s.role}${i}`} style={{ display: 'contents' }}>
                    <span style={{ fontSize: 12.5 }}>{s.label}{s.n > 1 ? ` ${i + 1}` : ''}</span>
                    <select className="text-input" value={mapping?.[s.role]?.[i] ?? ''} onChange={(e) => setSlot(s.role, i, e.target.value, s.n)}>
                      <option value="">— not in file —</option>
                      {report.headers!.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </label>
                )))}
              </div>
            </details>
          )}

          {!done && (
            <fieldset style={{ border: '1px solid var(--md-border)', borderRadius: 8, margin: '8px 0' }}>
              <legend style={{ fontSize: 12.5 }}>When a contact already exists (same email)</legend>
              {([['skip', 'Skip it'], ['merge', 'Merge into the existing contact (add emails, phones, groups; fill empty fields)'], ['fill', 'Only fill empty fields of the existing contact']] as [Mode, string][]).map(([m, l]) => (
                <label key={m} className="checkbox-line"><input type="radio" name="dupmode" checked={mode === m} onChange={() => { setMode(m); void repreview(mapping ?? {}, m); }} /> {l}</label>
              ))}
            </fieldset>
          )}

          {report.sample.length > 0 && !done && (
            <table style={{ fontSize: 12.5, width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ textAlign: 'left' }}><th>Name</th><th>Email</th><th>Phone</th><th>Org</th><th /></tr></thead>
              <tbody>{report.sample.map((s, i) => (
                <tr key={i} style={{ opacity: s.status === 'invalid' ? 0.55 : 1 }}>
                  <td>{s.name || '—'}</td><td>{s.emails.join(', ') || '—'}</td><td>{s.phones.join(', ')}</td><td>{s.org}</td>
                  <td><span className="contact-tag">{s.status}</span></td>
                </tr>))}</tbody>
            </table>
          )}

          {done && report.skippedRows.length > 0 && (
            <p style={{ margin: '8px 0' }}>{report.skippedRows.length} rows were skipped. <button className="btn ghost" onClick={downloadSkipped}>Download the skipped rows</button></p>
          )}
        </>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        {file && report && !done && <button className="btn primary" disabled={busy || report.total === 0} onClick={() => void doImport()}>{busy ? 'Working…' : `Import ${report.total - report.invalid} contacts`}</button>}
        <button className="btn ghost" onClick={onClose}>{done ? 'Close' : 'Cancel'}</button>
      </div>
    </div>
  );
}
