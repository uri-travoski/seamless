import { getLogo } from './businesses.ts';

/** For every `cid:logo-<businessId>` in the html, an inline attachment with that Content-ID (own businesses only). */
export async function logoAttachments(userId: number, html: string): Promise<Record<string, unknown>[]> {
  const ids = new Set([...html.matchAll(/cid:logo-(\d+)/g)].map((m) => Number(m[1])));
  const out: Record<string, unknown>[] = [];
  for (const id of ids) {
    const logo = await getLogo(userId, id);
    if (logo) out.push({ filename: logo.name, contentType: logo.type, content: logo.data, cid: `logo-${id}`, contentDisposition: 'inline' });
  }
  return out;
}
