import path from 'node:path';
import fs from 'node:fs';

function env(name: string, def?: string): string {
  const v = process.env[name] ?? def;
  if (v === undefined) throw new Error(`Missing required env var ${name}`);
  return v;
}

const isTest = process.env.NODE_ENV === 'test';

export const config = {
  port: Number(env('PORT', '4900')),
  dataDir: path.resolve(env('DATA_DIR', './data')),
  publicUrl: env('PUBLIC_URL', `http://localhost:${env('PORT', '4900')}`).replace(/\/$/, ''),
  secret: env('SEAMLESS_SECRET', isTest ? 'test-secret' : undefined),
  databaseUrl: env(
    'DATABASE_URL',
    isTest ? 'postgres://seamless:seamless@localhost:5460/seamless_test' : 'postgres://seamless:seamless@localhost:5460/seamless',
  ),
  s3: {
    endpoint: env('S3_ENDPOINT', 'http://localhost:9100'),
    region: env('S3_REGION', 'us-east-1'),
    bucket: env('S3_BUCKET', 'seamless'),
    accessKey: env('S3_ACCESS_KEY', 'seamless'),
    secretKey: env('S3_SECRET_KEY', 'seamless-secret'),
    forcePathStyle: env('S3_FORCE_PATH_STYLE', 'true') === 'true',
  },
};

fs.mkdirSync(config.dataDir, { recursive: true });
