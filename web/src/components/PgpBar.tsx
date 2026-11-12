import { useState } from 'react';
import type { ApiPgpStatus, ApiPgpKeyOffer, ApiSmimeStatus } from '@seamless/shared';
import { api } from '../api/client.ts';
import { toast } from '../toast.ts';
import { ShieldIcon, LockIcon, KeyIcon } from '../icons.tsx';

/** OpenPGP badge above the message body (T6.4 F-39): verified / unverified / bad signature, locked key, importable keys. */
export default function PgpBar({ emailId, pgp, smime, keys, onUnlock, onImported }: {
  emailId: string; pgp: ApiPgpStatus | null; smime?: ApiSmimeStatus | null; keys: ApiPgpKeyOffer[]; onUnlock: (passphrase: string) => void; onImported: () => void;
}) {
  const [pass, setPass] = useState('');
  const importKey = async (k: ApiPgpKeyOffer) => {
    try { await api.post('/api/pgp/import-from-message', { emailId, partId: Number(k.partId) }); toast(`Imported the key for ${k.email}`); onImported(); }
    catch (e: any) { toast(e?.message ?? 'Could not import that key', 'error'); }
  };
  return (
    <div className="pgp-bars">
      {smime && (
        <div className={`pgp-bar ${smime.signature === 'bad' || (smime.error && smime.signature === 'none') ? 'bad' : smime.signature === 'verified' ? 'ok' : 'warn'}`} role="status">
          {smime.encrypted && <span className="pgp-chip"><LockIcon size={14} weight="fill" /> {smime.decrypted ? 'S/MIME encrypted — decrypted for you' : 'S/MIME encrypted'}</span>}
          {smime.signature === 'verified' && <span className="pgp-chip"><ShieldIcon size={14} weight="fill" /> S/MIME signed by {smime.signer}, issuer {smime.issuer} — not checked against a trust store</span>}
          {smime.signature === 'unverified' && <span className="pgp-chip"><ShieldIcon size={14} /> S/MIME signature could not be fully verified</span>}
          {smime.signature === 'bad' && <span className="pgp-chip"><ShieldIcon size={14} weight="fill" /> Bad S/MIME signature — this message was changed or is not from who it claims</span>}
          {smime.error && <span className="pgp-note">{smime.error}</span>}
        </div>
      )}
      {pgp && (
        <div className={`pgp-bar ${pgp.signature === 'bad' || (pgp.error && !pgp.locked) ? 'bad' : pgp.signature === 'verified' ? 'ok' : 'warn'}`} role="status">
          {pgp.encrypted && <span className="pgp-chip"><LockIcon size={14} weight="fill" /> {pgp.decrypted ? 'Encrypted — decrypted for you' : 'Encrypted'}</span>}
          {pgp.signature === 'verified' && <span className="pgp-chip"><ShieldIcon size={14} weight="fill" /> Verified signature{pgp.signer ? ` from ${pgp.signer}` : ''}</span>}
          {pgp.signature === 'unverified' && <span className="pgp-chip"><ShieldIcon size={14} /> Signed, but you do not have the sender’s key — unverified</span>}
          {pgp.signature === 'bad' && <span className="pgp-chip"><ShieldIcon size={14} weight="fill" /> Bad signature — this message was changed or is not from who it claims</span>}
          {pgp.error && <span className="pgp-note">{pgp.error}</span>}
          {pgp.locked && (
            <form className="pgp-unlock" onSubmit={(e) => { e.preventDefault(); onUnlock(pass); setPass(''); }}>
              <input className="text-input" type="password" autoComplete="off" placeholder="Key passphrase" value={pass} onChange={(e) => setPass(e.target.value)} />
              <button className="btn" type="submit">Unlock</button>
            </form>
          )}
        </div>
      )}
      {keys.map((k) => (
        <div key={k.fingerprint} className="pgp-bar warn">
          <span className="pgp-chip"><KeyIcon size={14} /> Public key for {k.name ? `${k.name} <${k.email}>` : k.email} attached</span>
          {k.known ? <span className="pgp-note">already in your key ring</span> : <button className="btn" onClick={() => void importKey(k)}>Import key</button>}
        </div>
      ))}
    </div>
  );
}
