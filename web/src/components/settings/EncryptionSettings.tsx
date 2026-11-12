import { useEffect, useState } from 'react';
import type { ApiPgpKey, ApiIdentity, ApiSmimeCert } from '@seamless/shared';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';

const fmt = (fp: string) => fp.toUpperCase().replace(/(.{4})/g, '$1 ').trim();

/** OpenPGP keys (T6.4 F-39): your keys per identity, contact keys, import / export, WKD lookup. Server-side mode. */
export default function EncryptionSettings() {
  const [keys, setKeys] = useState<ApiPgpKey[]>([]);
  const [idents, setIdents] = useState<ApiIdentity[]>([]);
  const [identityId, setIdentityId] = useState<number | ''>('');
  const [pass, setPass] = useState('');
  const [armored, setArmored] = useState('');
  const [lookup, setLookup] = useState('');
  const [keyserver, setKeyserver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [certs, setCerts] = useState<ApiSmimeCert[]>([]);
  const [p12, setP12] = useState<File | null>(null);
  const [p12pass, setP12pass] = useState('');
  const [certPem, setCertPem] = useState('');
  const loadCerts = () => { void api.get<{ items: ApiSmimeCert[] }>('/api/smime/certs').then((r) => setCerts(r.items)).catch(() => {}); };
  const load = () => { void api.get<{ items: ApiPgpKey[] }>('/api/pgp/keys').then((r) => setKeys(r.items)).catch(() => {}); };
  useEffect(() => {
    load(); loadCerts();
    void api.get<ApiIdentity[]>('/api/identities').then((r) => { setIdents(r); if (r[0]) setIdentityId(r[0].id ?? ''); }).catch(() => {});
    void api.get<{ keyserver: boolean }>('/api/pgp/settings').then((r) => setKeyserver(r.keyserver)).catch(() => {});
  }, []);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); load(); } catch (e: any) { toast(e?.message ?? 'Failed', 'error'); } finally { setBusy(false); }
  };
  const runS = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); loadCerts(); } catch (e: any) { toast(e?.message ?? 'Failed', 'error'); } finally { setBusy(false); }
  };
  const importP12 = async () => {
    if (!p12) return;
    const bytes = new Uint8Array(await p12.arrayBuffer());
    let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
    await api.post('/api/smime/certs/import-p12', { data: btoa(bin), password: p12pass, identityId: identityId === '' ? null : identityId });
    setP12(null); setP12pass('');
  };
  const own = keys.filter((k) => k.kind === 'own');
  const contacts = keys.filter((k) => k.kind === 'contact');
  const Row = ({ k }: { k: ApiPgpKey }) => (
    <tr>
      <td>{k.email}{k.name ? <div className="hint">{k.name}</div> : null}</td>
      <td><code>{fmt(k.fingerprint)}</code>{k.passphraseProtected ? <div className="hint">passphrase-protected</div> : null}</td>
      <td className="row-actions">
        <a className="btn ghost" href={`/api/pgp/keys/${k.id}/public`} download>Export public</a>
        <button className="btn ghost" onClick={() => { if (window.confirm(`Delete the key for ${k.email}?${k.hasPrivate ? ' You will no longer be able to read mail encrypted to it.' : ''}`)) void run(() => api.del(`/api/pgp/keys/${k.id}`), 'Key deleted'); }}>Delete</button>
      </td>
    </tr>
  );
  return (
    <div className="settings-section">
      <h2>Encryption</h2>
      <p className="hint">OpenPGP, server-side mode: your private key is stored encrypted on this server (and locked with a passphrase if you set one). Seamless signs, encrypts and decrypts for you.
        Messages are decrypted when you open them and are not stored decrypted, so encrypted mail is not searchable by its content.</p>

      <h3>Your keys</h3>
      {own.length === 0 ? <p className="hint">No keys yet. Create one for an address you send from.</p> : (
        <table className="plain-table"><thead><tr><th>Address</th><th>Fingerprint</th><th /></tr></thead><tbody>{own.map((k) => <Row key={k.id} k={k} />)}</tbody></table>
      )}
      <div className="field-row">
        <select className="text-input" value={identityId} onChange={(e) => setIdentityId(e.target.value ? Number(e.target.value) : '')}>
          {idents.map((i) => <option key={i.id} value={i.id}>{i.email}</option>)}
        </select>
        <input className="text-input" type="password" autoComplete="new-password" placeholder="Passphrase (optional)" value={pass} onChange={(e) => setPass(e.target.value)} />
        <button className="btn primary" disabled={busy || identityId === ''} onClick={() => void run(async () => { await api.post('/api/pgp/keys/generate', { identityId, passphrase: pass || undefined }); setPass(''); }, 'Key created')}>Create key</button>
      </div>

      <h3>Import a key</h3>
      <p className="hint">Paste an armored key. A private key becomes one of your keys (for the identity above); a public key becomes a contact key.</p>
      <textarea className="text-input" rows={5} placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----" value={armored} onChange={(e) => setArmored(e.target.value)} />
      <div><button className="btn" disabled={busy || !armored.trim()} onClick={() => void run(async () => { await api.post('/api/pgp/keys/import', { armored, identityId: /PRIVATE KEY/.test(armored) && identityId !== '' ? identityId : undefined }); setArmored(''); }, 'Key imported')}>Import</button></div>

      <h3>Contact keys</h3>
      {contacts.length === 0 ? <p className="hint">None yet. Keys arrive by import, by an attached .asc file in mail you receive, or by lookup.</p> : (
        <table className="plain-table"><thead><tr><th>Address</th><th>Fingerprint</th><th /></tr></thead><tbody>{contacts.map((k) => <Row key={k.id} k={k} />)}</tbody></table>
      )}
      <div className="field-row">
        <input className="text-input" placeholder="name@example.com" value={lookup} onChange={(e) => setLookup(e.target.value)} />
        <button className="btn" disabled={busy || !lookup.includes('@')} onClick={() => void run(async () => {
          const r = await api.post<{ found: boolean; source?: string }>('/api/pgp/lookup', { email: lookup });
          if (!r.found) throw new Error(`No public key found for ${lookup}`);
          setLookup('');
        }, 'Key found and saved')}>Look up (WKD)</button>
      </div>
      <label className="check-row"><input type="checkbox" checked={keyserver} onChange={(e) => { const v = e.target.checked; void api.put('/api/pgp/settings', { keyserver: v }).then(() => setKeyserver(v)).catch(() => {}); }} />
        Also ask keys.openpgp.org when WKD finds nothing (off by default: it tells that server who you write to)</label>

      <h2>S/MIME</h2>
      <p className="hint">S/MIME signs and encrypts with an X.509 certificate (what Outlook, Apple Mail and Thunderbird use). Import the certificate and key as a password-protected
        <code>.p12</code> / <code>.pfx</code> file; the key is stored encrypted on this server. Seamless shows who signed a message and who issued the certificate,
        but does <b>not</b> check the certificate chain against a trust store.</p>
      {certs.length === 0 ? <p className="hint">No S/MIME certificates yet.</p> : (
        <table className="plain-table"><thead><tr><th>Address</th><th>Certificate</th><th /></tr></thead><tbody>{certs.map((c) => (
          <tr key={c.id}>
            <td>{c.email}<div className="hint">{c.kind === 'own' ? 'yours (can sign and decrypt)' : 'contact (collected from signed mail or imported)'}</div></td>
            <td><div>{c.subject}</div><div className="hint">issuer {c.issuer} · {c.expired ? 'EXPIRED ' : 'valid until '}{new Date(c.notAfter).toLocaleDateString()}</div></td>
            <td className="row-actions">
              <a className="btn ghost" href={`/api/smime/certs/${c.id}/pem`} download>Export certificate</a>
              <button className="btn ghost" onClick={() => { if (window.confirm(`Delete the certificate for ${c.email}?${c.hasPrivate ? ' You will no longer be able to read mail encrypted to it.' : ''}`)) void runS(() => api.del(`/api/smime/certs/${c.id}`), 'Certificate deleted'); }}>Delete</button>
            </td>
          </tr>))}</tbody></table>
      )}
      <h3>Import your certificate (.p12)</h3>
      <div className="field-row">
        <select className="text-input" value={identityId} onChange={(e) => setIdentityId(e.target.value ? Number(e.target.value) : '')}>
          {idents.map((i) => <option key={i.id} value={i.id}>{i.email}</option>)}
        </select>
        <input className="text-input" type="file" accept=".p12,.pfx,application/x-pkcs12" onChange={(e) => setP12(e.target.files?.[0] ?? null)} />
        <input className="text-input" type="password" autoComplete="off" placeholder="File password" value={p12pass} onChange={(e) => setP12pass(e.target.value)} />
        <button className="btn primary" disabled={busy || !p12 || identityId === ''} onClick={() => void runS(importP12, 'Certificate imported')}>Import</button>
      </div>
      <h3>Add a contact’s certificate</h3>
      <textarea className="text-input" rows={4} placeholder="-----BEGIN CERTIFICATE-----" value={certPem} onChange={(e) => setCertPem(e.target.value)} />
      <div><button className="btn" disabled={busy || !certPem.trim()} onClick={() => void runS(async () => { await api.post('/api/smime/certs/import', { pem: certPem }); setCertPem(''); }, 'Certificate added')}>Add</button></div>
    </div>
  );
}
