import { S3Client, PutObjectCommand, GetObjectCommand, CreateBucketCommand, HeadBucketCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
import { config } from './config.ts';

/** The blob operations the app needs. S3/R2 in production; the tests swap in an
 *  in-memory implementation so a round-trip needs no bucket. */
export interface BlobStore {
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  list(prefix: string): Promise<string[]>;
  del(key: string): Promise<void>;
  /** Size in bytes, or null when the object does not exist. Optional: the in-memory test store falls back to get(). */
  head?(key: string): Promise<number | null>;
}

export interface S3Config {
  endpoint: string; region: string; bucket: string;
  accessKey: string; secretKey: string; forcePathStyle: boolean;
}

export type Store = BlobStore & { bucket: string; ensure(): Promise<void>; headBucket(): Promise<void> };

export function makeStore(cfg: S3Config): Store {
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
  });

  return {
    bucket: cfg.bucket,

    async ensure() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket: cfg.bucket }));
      }
    },

    /** Auth + existence check, without creating anything (unlike `ensure`). */
    async headBucket() {
      await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
    },

    async put(key, body, contentType = 'message/rfc822') {
      await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: body, ContentType: contentType }));
    },

    async get(key) {
      const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
      return Buffer.from(await res.Body!.transformToByteArray());
    },

    async del(key) {
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
    },

    async head(key) {
      try {
        const r = await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
        return Number(r.ContentLength ?? 0);
      } catch (err: any) {
        if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return null;
        throw err;
      }
    },

    /** Paged, so a bucket holding years of mail still enumerates a prefix fully. */
    async list(prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const res = await client.send(new ListObjectsV2Command({
          Bucket: cfg.bucket, Prefix: prefix, ContinuationToken: token,
        }));
        for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
  };
}

/** Mail blobs (.eml archive) and database backups are separate stores, so backups can live
 *  in another bucket — or another provider — from the mail they protect. They collapse to
 *  the same bucket when no S3_BACKUP_* vars are set.
 *
 *  The mail store is REPOINTABLE at runtime: a restore brings the mail-bucket config back
 *  inside the backup, and the running server has to start reading blobs from wherever that
 *  says — without a restart, since the restore happens through the web UI. */
let mailCfg: S3Config = { ...config.s3 };
let mail = makeStore(mailCfg);

export function mailStoreConfig(): S3Config { return { ...mailCfg }; }

/** Where the mail lives, minus the credentials — safe to log, show, or put in a manifest. */
export function mailStoreLocation(): { endpoint: string; region: string; bucket: string; forcePathStyle: boolean } {
  const { endpoint, region, bucket, forcePathStyle } = mailCfg;
  return { endpoint, region, bucket, forcePathStyle };
}

export function setMailStore(cfg: S3Config): void {
  mailCfg = { ...cfg };
  mail = makeStore(mailCfg);
  backupSharesMailBucket = computeShared();
}

/** Indirect on purpose: every caller below re-reads `mail`, so repointing the store takes
 *  effect immediately for code that imported these helpers at module load. */
export const mailStore: BlobStore & { bucket: string; ensure(): Promise<void> } = {
  get bucket() { return mailCfg.bucket; },
  ensure: () => mail.ensure(),
  put: (k, b, ct) => mail.put(k, b, ct),
  get: (k) => mail.get(k),
  list: (p) => mail.list(p),
  del: (k) => mail.del(k),
};

/** The backup store is repointable too (a `storage_targets` row with role='backup'). */
let backupCfg: S3Config = { ...config.s3Backup };
let backup = makeStore(backupCfg);

export function backupStoreConfig(): S3Config { return { ...backupCfg }; }
export function setBackupStore(cfg: S3Config): void {
  backupCfg = { ...cfg };
  backup = makeStore(backupCfg);
  backupSharesMailBucket = computeShared();
}

export const backupStore: BlobStore & { bucket: string; ensure(): Promise<void> } = {
  get bucket() { return backupCfg.bucket; },
  ensure: () => backup.ensure(),
  put: (k, b, ct) => backup.put(k, b, ct),
  get: (k) => backup.get(k),
  list: (p) => backup.list(p),
  del: (k) => backup.del(k),
};

const computeShared = () => backupCfg.bucket === mailCfg.bucket && backupCfg.endpoint === mailCfg.endpoint;
/** Same bucket + endpoint means one store is doing both jobs (the default). */
export let backupSharesMailBucket = computeShared();

export async function ensureBucket(): Promise<void> {
  await mailStore.ensure();
  if (!backupSharesMailBucket) await backupStore.ensure();
}

// mail-blob helpers used across ingest/send/safe-delete
export const putBlob: BlobStore['put'] = (k, b, ct) => mail.put(k, b, ct);
export const getBlob: BlobStore['get'] = (k) => mail.get(k);
export const deleteBlob: BlobStore['del'] = (k) => mail.del(k);
export const listKeys: BlobStore['list'] = (p) => mail.list(p);

/** @deprecated use `mailStore`; kept so existing imports keep meaning the mail bucket. */
export const s3Store: BlobStore = mailStore;
