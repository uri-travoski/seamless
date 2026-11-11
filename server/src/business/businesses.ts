/** Businesses (F-30): CRUD, logo storage. Everything is scoped by user_id. */
import sanitizeHtml from 'sanitize-html';
import { q, one, run, insertId } from '../db.ts';
import { sha256 } from '../crypto.ts';
import { putBlob, getBlob, deleteBlob } from '../s3.ts';
import type { SigBusiness } from './signature.ts';

export interface BusinessRow extends SigBusiness { user_id: number; short_name: string; brand_color: string; created_at: number | string }

export const MAX_LOGO = 512 * 1024;

export interface ApiBusiness {
  id: number; name: string; shortName: string; hasLogo: boolean; brandColor: string; website: string; phone: string;
  abn: string; address: string; defaultSignatureHtml: string; disclaimerHtml: string;
}

export const toApi = (r: BusinessRow): ApiBusiness => ({
  id: r.id, name: r.name, shortName: r.short_name, hasLogo: !!r.logo_key, brandColor: r.brand_color, website: r.website,
  phone: r.phone, abn: r.abn, address: r.address, defaultSignatureHtml: r.default_signature_html, disclaimerHtml: r.disclaimer_html,
});

export const listBusinesses = (userId: number) => q<BusinessRow>('SELECT * FROM businesses WHERE user_id = ? ORDER BY lower(name), id', [userId]);
export const getBusiness = (userId: number, id: number) => one<BusinessRow>('SELECT * FROM businesses WHERE id = ? AND user_id = ?', [id, userId]);

const SIG_HTML: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'a', 'span', 'div', 'img', 'table', 'tbody', 'tr', 'td', 'hr'],
  allowedAttributes: { a: ['href'], img: ['src', 'alt', 'style', 'width', 'height'], '*': ['style'] },
  allowedSchemes: ['http', 'https', 'mailto', 'cid'],
};

export const cleanSigHtml = (html: string) => sanitizeHtml(html, SIG_HTML);

export interface BusinessInput {
  name?: string; shortName?: string; brandColor?: string; website?: string; phone?: string; abn?: string; address?: string;
  defaultSignatureHtml?: string; disclaimerHtml?: string;
}

export function validate(b: BusinessInput, creating: boolean): string | null {
  if (creating && !String(b.name ?? '').trim()) return 'name required';
  if (b.brandColor !== undefined && !/^#[0-9a-fA-F]{6}$/.test(b.brandColor)) return 'brandColor must be #rrggbb';
  return null;
}

export async function createBusiness(userId: number, b: BusinessInput): Promise<number> {
  return insertId(`
    INSERT INTO businesses(user_id, name, short_name, brand_color, website, phone, abn, address, default_signature_html, disclaimer_html, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
    userId, String(b.name).trim(), b.shortName ?? '', b.brandColor ?? '#2f7ed8', b.website ?? '', b.phone ?? '', b.abn ?? '', b.address ?? '',
    sanitizeHtml(b.defaultSignatureHtml ?? '', SIG_HTML), sanitizeHtml(b.disclaimerHtml ?? '', SIG_HTML), Date.now()]);
}

export async function updateBusiness(userId: number, id: number, b: BusinessInput): Promise<boolean> {
  const e = await getBusiness(userId, id);
  if (!e) return false;
  await run(`UPDATE businesses SET name=?, short_name=?, brand_color=?, website=?, phone=?, abn=?, address=?, default_signature_html=?, disclaimer_html=?
             WHERE id=? AND user_id=?`, [
    b.name === undefined ? e.name : String(b.name).trim(), b.shortName ?? e.short_name, b.brandColor ?? e.brand_color,
    b.website ?? e.website, b.phone ?? e.phone, b.abn ?? e.abn, b.address ?? e.address,
    b.defaultSignatureHtml === undefined ? e.default_signature_html : sanitizeHtml(b.defaultSignatureHtml, SIG_HTML),
    b.disclaimerHtml === undefined ? e.disclaimer_html : sanitizeHtml(b.disclaimerHtml, SIG_HTML), id, userId]);
  return true;
}

export async function deleteBusiness(userId: number, id: number): Promise<boolean> {
  const e = await getBusiness(userId, id);
  if (!e) return false;
  await run('DELETE FROM businesses WHERE id = ? AND user_id = ?', [id, userId]);
  await dropLogoBlob(e.logo_key);
  return true;
}

async function dropLogoBlob(key: string | null): Promise<void> {
  if (!key) return;
  const still = await one('SELECT id FROM businesses WHERE logo_key = ?', [key]);
  if (!still) await deleteBlob(key).catch(() => {});
}

/** Detect png/jpeg by magic bytes, accept svg only if it has no script-capable content. */
export function detectLogo(data: Buffer): { ext: 'png' | 'jpg' | 'svg'; type: string } | null {
  if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', type: 'image/png' };
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  const text = data.toString('utf8');
  if (/<svg[\s>]/i.test(text) && !/<script|<foreignObject|<!ENTITY|<!DOCTYPE|\son\w+\s*=|javascript:|(?:xlink:)?href\s*=\s*["'](?!#)|<iframe|<embed|<object/i.test(text)) {
    return { ext: 'svg', type: 'image/svg+xml' };
  }
  return null;
}

export async function setLogo(userId: number, id: number, data: Buffer): Promise<{ ok: true } | { ok: false; error: string; code: number }> {
  const e = await getBusiness(userId, id);
  if (!e) return { ok: false, error: 'not found', code: 404 };
  if (data.length > MAX_LOGO) return { ok: false, error: 'logo must be 512 KB or smaller', code: 413 };
  const kind = detectLogo(data);
  if (!kind) return { ok: false, error: 'logo must be a PNG, JPEG or plain SVG', code: 400 };
  const key = `logo/${userId}/${sha256(data)}.${kind.ext}`;
  await putBlob(key, data, kind.type);
  await run('UPDATE businesses SET logo_key = ? WHERE id = ? AND user_id = ?', [key, id, userId]);
  if (e.logo_key && e.logo_key !== key) await dropLogoBlob(e.logo_key);
  return { ok: true };
}

export async function getLogo(userId: number, id: number): Promise<{ data: Buffer; type: string; name: string } | null> {
  const e = await getBusiness(userId, id);
  if (!e?.logo_key) return null;
  const ext = e.logo_key.split('.').pop();
  const type = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : 'image/png';
  return { data: Buffer.from(await getBlob(e.logo_key)), type, name: `logo-${id}.${ext}` };
}
