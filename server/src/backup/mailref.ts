import { one, getSetting, setSetting } from '../db.ts';
import { config } from '../config.ts';
import { encrypt, decrypt, sha256 } from '../crypto.ts';
import { activeTarget, toS3Config } from '../storage/targets.ts';
import { setMailStore, mailStoreConfig, mailStoreLocation, getBlob, type S3Config } from '../s3.ts';

/**
 * Makes a backup self-describing about its mail.
 *
 * The database dump carries every message's `s3_key` (`msg/<account>/<sha256>.eml`) but a
 * key alone says nothing about WHICH bucket holds it. So the mail-store config is kept in
 * the `settings` table, which means it rides inside the encrypted dump for free — and a
 * restore can then reconnect to the mail bucket on its own, without the operator having to
 * remember and retype S3_* on the rebuilt box.
 *
 * The credentials are encrypted with SEAMLESS_SECRET before they are stored, exactly like
 * `accounts.auth_enc` (the IMAP passwords and OAuth tokens that already travel in every
 * backup). Reading them therefore needs the same thing reading any of it needs: the secret.
 * Keep SEAMLESS_SECRET off the server.
 *
 * The BACKUP store's own credentials are deliberately NOT stored here: you need them before
 * you can read the backup, so they can never come out of it. Those stay in the environment
 * (or get typed into the setup screen).
 */

const SETTING_KEY = 'mail_s3';

export async function saveMailStoreConfig(cfg: S3Config = mailStoreConfig()): Promise<void> {
  await setSetting(SETTING_KEY, encrypt(JSON.stringify(cfg)));
}

export async function loadMailStoreConfig(): Promise<S3Config | null> {
  const raw = await getSetting(SETTING_KEY);
  if (!raw) return null;
  try {
    const cfg = JSON.parse(decrypt(raw)) as S3Config;
    return cfg?.bucket ? cfg : null;
  } catch {
    // written under a different SEAMLESS_SECRET — unreadable, so fall back to the environment
    return null;
  }
}

/**
 * Boot: decide where mail blobs live.
 *
 * A bucket named in the environment always wins — that is the operator speaking, and it is
 * how you migrate the mail to a new bucket. Otherwise, if the database remembers a mail
 * store (i.e. we were restored), use that. The built-in localhost defaults are the last
 * resort and must never silently override what a restore brought back.
 */
export async function initMailStore(): Promise<{ source: 'env' | 'target' | 'restored' | 'default'; bucket: string }> {
  const stored = await loadMailStoreConfig();

  if (config.s3FromEnv) {
    setMailStore(config.s3);
    await saveMailStoreConfig(config.s3);          // keep the record current for the next backup
    return { source: 'env', bucket: config.s3.bucket };
  }
  // a target chosen in Settings → Storage (F-26) beats a restored record and the defaults
  const target = await activeTarget('mail').catch(() => undefined);
  if (target) {
    const cfg = toS3Config(target);
    setMailStore(cfg);
    await saveMailStoreConfig(cfg);
    return { source: 'target', bucket: cfg.bucket };
  }
  if (stored) {
    setMailStore(stored);
    return { source: 'restored', bucket: stored.bucket };
  }
  setMailStore(config.s3);
  await saveMailStoreConfig(config.s3);
  return { source: 'default', bucket: config.s3.bucket };
}

/** After a restore: adopt the mail store the backup came with, unless the environment
 *  explicitly names one (an operator moving buckets must still be able to say so). */
export async function adoptRestoredMailStore(): Promise<{ adopted: boolean; bucket: string; endpoint: string }> {
  const stored = await loadMailStoreConfig();
  if (stored && !config.s3FromEnv) {
    setMailStore(stored);
    return { adopted: true, bucket: stored.bucket, endpoint: stored.endpoint };
  }
  const loc = mailStoreLocation();
  return { adopted: false, bucket: loc.bucket, endpoint: loc.endpoint };
}

export interface BlobCheck {
  checked: boolean;      // false when the restore holds no blobs to check
  ok: boolean;
  bucket: string;
  key?: string;
  error?: string;
}

/**
 * Prove the mail bucket is actually reachable and actually holds this backup's mail.
 *
 * Without this a restore "succeeds" with every row in place and every message body 404ing —
 * the failure only surfaces when a human opens an email, which is far too late. The key
 * embeds the blob's sha256, so a fetch plus a hash tells us we reached the right bucket and
 * not merely *a* bucket.
 */
export async function verifyMailBlobs(): Promise<BlobCheck> {
  const bucket = mailStoreLocation().bucket;
  const row = await one<{ s3_key: string }>(
    "SELECT s3_key FROM messages WHERE s3_key IS NOT NULL AND s3_key LIKE '%.eml' ORDER BY id LIMIT 1");
  if (!row?.s3_key) return { checked: false, ok: true, bucket };

  try {
    const raw = await getBlob(row.s3_key);
    const want = row.s3_key.match(/([a-f0-9]{64})\.eml$/)?.[1];
    if (want && sha256(raw) !== want) {
      return { checked: true, ok: false, bucket, key: row.s3_key, error: 'blob found but its checksum does not match — wrong bucket?' };
    }
    return { checked: true, ok: true, bucket, key: row.s3_key };
  } catch (err: any) {
    return { checked: true, ok: false, bucket, key: row.s3_key, error: err?.message ?? 'mail blob could not be read' };
  }
}
