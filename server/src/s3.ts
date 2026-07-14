import { S3Client, PutObjectCommand, GetObjectCommand, CreateBucketCommand, HeadBucketCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { config } from './config.ts';

/** The blob operations the backup engine needs. S3/R2 in production; the tests
 *  swap in an in-memory implementation so a round-trip needs no bucket. */
export interface BlobStore {
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  list(prefix: string): Promise<string[]>;
  del(key: string): Promise<void>;
}

const client = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  forcePathStyle: config.s3.forcePathStyle,
  credentials: { accessKeyId: config.s3.accessKey, secretAccessKey: config.s3.secretKey },
});

export async function ensureBucket(): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.s3.bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: config.s3.bucket }));
  }
}

export async function putBlob(key: string, body: Buffer, contentType = 'message/rfc822'): Promise<void> {
  await client.send(new PutObjectCommand({ Bucket: config.s3.bucket, Key: key, Body: body, ContentType: contentType }));
}

export async function getBlob(key: string): Promise<Buffer> {
  const res = await client.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }));
  return Buffer.from(await res.Body!.transformToByteArray());
}

export async function deleteBlob(key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
}

/** Paged so a bucket holding years of mail still enumerates a backup prefix fully. */
export async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: config.s3.bucket, Prefix: prefix, ContinuationToken: token,
    }));
    for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

export const s3Store: BlobStore = {
  put: putBlob,
  get: getBlob,
  list: listKeys,
  del: deleteBlob,
};
