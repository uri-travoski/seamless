import { S3Client, PutObjectCommand, GetObjectCommand, CreateBucketCommand, HeadBucketCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { config } from './config.ts';

/** The blob operations the app needs. S3/R2 in production; the tests swap in an
 *  in-memory implementation so a round-trip needs no bucket. */
export interface BlobStore {
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  list(prefix: string): Promise<string[]>;
  del(key: string): Promise<void>;
}

interface S3Config {
  endpoint: string; region: string; bucket: string;
  accessKey: string; secretKey: string; forcePathStyle: boolean;
}

function makeStore(cfg: S3Config): BlobStore & { bucket: string; ensure(): Promise<void> } {
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
 *  the same bucket when no S3_BACKUP_* vars are set. */
export const mailStore = makeStore(config.s3);
export const backupStore = makeStore(config.s3Backup);

/** Same bucket + endpoint means one store is doing both jobs (the default). */
export const backupSharesMailBucket =
  config.s3Backup.bucket === config.s3.bucket && config.s3Backup.endpoint === config.s3.endpoint;

export async function ensureBucket(): Promise<void> {
  await mailStore.ensure();
  if (!backupSharesMailBucket) await backupStore.ensure();
}

// mail-blob helpers used across ingest/send/safe-delete
export const putBlob = mailStore.put;
export const getBlob = mailStore.get;
export const deleteBlob = mailStore.del;
export const listKeys = mailStore.list;

/** @deprecated use `mailStore`; kept so existing imports keep meaning the mail bucket. */
export const s3Store: BlobStore = mailStore;
