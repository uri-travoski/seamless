import path from 'node:path';
import fs from 'node:fs';

function env(name: string, def?: string): string {
  const v = process.env[name] ?? def;
  if (v === undefined) throw new Error(`Missing required env var ${name}`);
  return v;
}

const isTest = process.env.NODE_ENV === 'test';

/** The app's own name, from the root package.json. Everything this app writes into shared
 *  storage is namespaced under it, so one bucket can serve many apps without collision. */
function appName(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { name?: string };
    const name = (pkg.name ?? '').trim().replace(/^@[^/]+\//, '').replace(/[^a-z0-9._-]/gi, '-');
    if (name) return name;
  } catch {
    // fall through: a missing package.json must not stop the server booting
  }
  return 'seamless';
}

const APP = appName();

export const config = {
  appName: APP,
  /** Root folder for anything this app stores in shared object storage. */
  appFolder: `${APP}/`,
  port: Number(env('PORT', '4900')),
  dataDir: path.resolve(env('DATA_DIR', './data')),
  publicUrl: env('PUBLIC_URL', `http://localhost:${env('PORT', '4900')}`).replace(/\/$/, ''),
  secret: env('SEAMLESS_SECRET', isTest ? 'test-secret' : undefined),
  databaseUrl: env(
    'DATABASE_URL',
    isTest ? 'postgres://seamless:seamless@localhost:5460/seamless_test' : 'postgres://seamless:seamless@localhost:5460/seamless',
  ),
  // Mail blobs: the raw .eml archive.
  s3: {
    endpoint: env('S3_ENDPOINT', 'http://localhost:9100'),
    region: env('S3_REGION', 'us-east-1'),
    bucket: env('S3_BUCKET', 'seamless'),
    accessKey: env('S3_ACCESS_KEY', 'seamless'),
    secretKey: env('S3_SECRET_KEY', 'seamless-secret'),
    forcePathStyle: env('S3_FORCE_PATH_STYLE', 'true') === 'true',
  },
  // Database backups. Each S3_BACKUP_* falls back to its S3_* twin, so leaving them unset
  // keeps the old single-bucket behaviour. Set S3_BACKUP_BUCKET to separate the two, and
  // the endpoint/credentials too to put backups in a different account or provider
  // entirely — then losing the mail bucket (or its credentials) cannot take the backups
  // with it, which is the whole point of a backup.
  s3Backup: {
    endpoint: env('S3_BACKUP_ENDPOINT', env('S3_ENDPOINT', 'http://localhost:9100')),
    region: env('S3_BACKUP_REGION', env('S3_REGION', 'us-east-1')),
    bucket: env('S3_BACKUP_BUCKET', env('S3_BUCKET', 'seamless')),
    accessKey: env('S3_BACKUP_ACCESS_KEY', env('S3_ACCESS_KEY', 'seamless')),
    secretKey: env('S3_BACKUP_SECRET_KEY', env('S3_SECRET_KEY', 'seamless-secret')),
    forcePathStyle: env('S3_BACKUP_FORCE_PATH_STYLE', env('S3_FORCE_PATH_STYLE', 'true')) === 'true',
  },
  // Where backups live in the bucket: always inside the app folder, never at the bucket root
  // and never in a generic `backup/` prefix, so one bucket can hold several apps' backups.
  // A BACKUP_PREFIX that points elsewhere is nested under the app folder, not honoured as-is.
  // The UI setting is stored in Postgres — which is the thing a disaster destroys — so on a
  // rebuilt box this env var is the only thing left that knows the prefix.
  backupPrefix: (() => {
    let p = env('BACKUP_PREFIX', `${APP}/`).trim().replace(/^\/+/, '');
    if (!p.endsWith('/')) p = `${p}/`;
    if (p === '/') return `${APP}/`;
    return p.startsWith(`${APP}/`) ? p : `${APP}/${p}`;
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
