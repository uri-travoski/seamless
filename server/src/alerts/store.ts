/** Alert channel storage: config is JSON encrypted with SEAMLESS_SECRET; secret fields are never returned. */
import { q, one, run, insertId } from '../db.ts';
import { encrypt, decrypt } from '../crypto.ts';
import { adapter, ChannelError, type ChannelKind } from './channels/index.ts';

export interface ChannelRow {
  id: number; user_id: number; kind: ChannelKind; name: string; scope: 'user' | 'team'; config_enc: string;
  enabled: boolean; verified_at: string | number | null; last_ok_at: string | number | null; last_error: string | null; created_at: string | number;
}

export interface ApiAlertChannel {
  id: number; kind: ChannelKind; name: string; scope: 'user' | 'team'; mine: boolean; enabled: boolean;
  verifiedAt: number | null; lastOkAt: number | null; lastError: string | null; createdAt: number;
  summary: string;
  /** non-secret settings, for the edit form */
  config: Record<string, any>;
  /** which secret fields have a value (the value itself is never sent) */
  secretsSet: string[];
}

export function readConfig(row: ChannelRow): Record<string, any> {
  return JSON.parse(decrypt(row.config_enc));
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export function toApi(row: ChannelRow, viewerId: number): ApiAlertChannel {
  const ad = adapter(row.kind)!;
  const cfg = readConfig(row);
  const pub: Record<string, any> = {};
  for (const [k, v] of Object.entries(cfg)) if (!ad.secrets.includes(k)) pub[k] = v;
  let summary = '';
  try { summary = ad.describe(cfg); } catch { /* keep blank */ }
  return {
    id: row.id, kind: row.kind, name: row.name, scope: row.scope, mine: row.user_id === viewerId, enabled: row.enabled,
    verifiedAt: num(row.verified_at), lastOkAt: num(row.last_ok_at), lastError: row.last_error, createdAt: Number(row.created_at),
    summary, config: pub, secretsSet: ad.secrets.filter((k) => !!cfg[k]),
  };
}

/** Channels the viewer may see: their own, plus team channels set up by an admin. */
export async function listChannels(userId: number): Promise<ChannelRow[]> {
  return q<ChannelRow>(`SELECT * FROM alert_channels WHERE user_id = ? OR scope = 'team' ORDER BY id`, [userId]);
}

export async function getOwnChannel(userId: number, id: number): Promise<ChannelRow | null> {
  return (await one<ChannelRow>('SELECT * FROM alert_channels WHERE id = ? AND user_id = ?', [id, userId])) ?? null;
}

export async function createChannel(userId: number, isAdmin: boolean, body: Record<string, any>): Promise<ChannelRow> {
  const ad = adapter(String(body.kind));
  if (!ad) throw new ChannelError('Choose a channel type: email, Twilio, phone gateway or Telegram');
  const scope = body.scope === 'team' ? 'team' : 'user';
  if (scope === 'team' && !isAdmin) throw new ChannelError('Only an administrator can add a channel for the whole team');
  const cfg = ad.validate(body.config ?? {});
  const name = String(body.name ?? '').trim().slice(0, 80) || ad.label;
  const id = await insertId(`INSERT INTO alert_channels(user_id, kind, name, scope, config_enc, enabled, created_at) VALUES (?,?,?,?,?,?,?)`,
    [userId, ad.kind, name, scope, encrypt(JSON.stringify(cfg)), body.enabled !== false, Date.now()]);
  return (await getOwnChannel(userId, id))!;
}

/** Blank secret fields keep the stored value. Changing the settings clears "verified": it has to be tested again. */
export async function updateChannel(userId: number, id: number, body: Record<string, any>): Promise<ChannelRow | null> {
  const row = await getOwnChannel(userId, id);
  if (!row) return null;
  const ad = adapter(row.kind)!;
  let enc = row.config_enc;
  let verified: number | null = row.verified_at === null ? null : Number(row.verified_at);
  if (body.config) {
    const old = readConfig(row);
    const merged: Record<string, any> = { ...body.config };
    for (const k of ad.secrets) if (!String(merged[k] ?? '').trim()) merged[k] = old[k];
    const next = ad.validate(merged);
    if (JSON.stringify(next) !== JSON.stringify(old)) verified = null;
    enc = encrypt(JSON.stringify(next));
  }
  const name = body.name !== undefined ? String(body.name).trim().slice(0, 80) || ad.label : row.name;
  const enabled = body.enabled !== undefined ? !!body.enabled : row.enabled;
  await run('UPDATE alert_channels SET name = ?, config_enc = ?, enabled = ?, verified_at = ? WHERE id = ? AND user_id = ?', [name, enc, enabled, verified, id, userId]);
  return getOwnChannel(userId, id);
}

export async function deleteChannel(userId: number, id: number): Promise<boolean> {
  return (await run('DELETE FROM alert_channels WHERE id = ? AND user_id = ?', [id, userId])) > 0;
}

/** Does this user have a working outside channel (their own or the team's)? */
export async function hasVerifiedChannel(userId: number): Promise<boolean> {
  return !!(await one(`SELECT 1 FROM alert_channels WHERE enabled = true AND verified_at IS NOT NULL AND (user_id = ? OR scope = 'team') LIMIT 1`, [userId]));
}
