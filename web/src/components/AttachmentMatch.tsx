/** "Matched in invoice-1234.pdf: …snippet…" (T6.2 F-41). The server marks hits with << >> in plain text. */
import type { ApiEmail } from '@seamless/shared';

export function AttachmentMatch({ email }: { email: ApiEmail }) {
  const m = email.attachmentMatch;
  if (!m) return null;
  const parts = m.snippet.split(/(<<.*?>>)/g).filter(Boolean);
  return (
    <div className="att-match">
      Matched in <strong>{m.filename}</strong>: …
      {parts.map((p, i) => (p.startsWith('<<') ? <mark key={i}>{p.slice(2, -2)}</mark> : <span key={i}>{p}</span>))}…
    </div>
  );
}
