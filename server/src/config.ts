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
  // Where backups live in the bucket: always namespaced under an app folder (`seamless/`),
  // so one bucket can hold several apps' backups without them colliding.
  // The UI setting is stored in Postgres — which is the thing a disaster destroys — so on a
  // rebuilt box this env var is the only thing left that knows the prefix.
  backupPrefix: (() => {
    const p = env('BACKUP_PREFIX', 'seamless/');
    return p.endsWith('/') ? p : `${p}/`;
  })(),
  facade: {
    imapPort: Number(env('FACADE_IMAP_PORT', '1143')),
    smtpPort: Number(env('FACADE_SMTP_PORT', '1587')),
    // set both to serve IMAPS on 993-style ports; plain otherwise (put a TLS proxy in front)
    tlsKeyFile: process.env.FACADE_TLS_KEY ?? '',
    tlsCertFile: process.env.FACADE_TLS_CERT ?? '',
    enabled: env('FACADE_ENABLED', 'true') === 'true',
  },
};

fs.mkdirSync(config.dataDir, { recursive: true });
