/** Signature rendering (F-30): variables, inline logo (CID) and the business disclaimer. */
export interface SigBusiness {
  id: number; name: string; phone: string; website: string; abn: string; address: string;
  logo_key: string | null; default_signature_html: string; disclaimer_html: string;
}
export interface SigIdentity { email: string; display_name: string; signature_html: string | null }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const logoCid = (businessId: number) => `logo-${businessId}`;

/** The identity's own signature wins; otherwise the business default. Empty string if neither. */
export function renderSignature(identity: SigIdentity, business: SigBusiness | null): string {
  const base = identity.signature_html ?? business?.default_signature_html ?? '';
  const vars: Record<string, string> = {
    'business.name': esc(business?.name ?? ''),
    'business.phone': esc(business?.phone ?? ''),
    'business.website': esc(business?.website ?? ''),
    'business.abn': esc(business?.abn ?? ''),
    'business.address': esc(business?.address ?? '').replace(/\r?\n/g, '<br>'),
    'identity.name': esc(identity.display_name),
    'identity.email': esc(identity.email),
    logo: business?.logo_key ? `<img src="cid:${logoCid(business.id)}" alt="${esc(business.name)}" style="max-height:80px">` : '',
  };
  let html = base.replace(/\{\{\s*([a-z_.]+)\s*\}\}/g, (m, k: string) => (k in vars ? vars[k] : m));
  if (business?.disclaimer_html) html += `<div class="disclaimer">${business.disclaimer_html}</div>`;
  return html;
}
