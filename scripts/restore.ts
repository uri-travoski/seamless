/**
 * Disaster recovery from the terminal.
 *
 *   npm run restore -- --list             show what is in the bucket
 *   npm run restore -- --latest           restore the newest backup
 *   npm run restore -- --key backup/2026-07-14T02-00-00-000Z/
 *   npm run restore -- --latest --verify-only   check it reads back, change nothing
 *
 * Needs the same .env as the server: DATABASE_URL, S3_* (pointed at the surviving
 * bucket) and — critically — the SEAMLESS_SECRET the backup was written with.
 * Restoring TRUNCATES every table, so it refuses to run against a database that
 * still has users unless --force is given.
 */
import { listBackups, verifyBackup, restoreBackup, databaseIsEmpty } from '../server/src/backup/engine.ts';
import { getBackupConfig, normalizePrefix } from '../server/src/backup/schedule.ts';
import { migrate, pool } from '../server/src/db.ts';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

const fmtBytes = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

async function main() {
  await migrate();
  // --prefix wins, then BACKUP_PREFIX / the stored setting. A rebuilt box has no stored
  // setting, so a non-default prefix must be supplied here or via the env var. Either way
  // it is namespaced into the app folder, matching where backups were actually written.
  const raw = val('--prefix');
  const prefix = raw ? normalizePrefix(raw) : (await getBackupConfig()).prefix;
  const backups = await listBackups({ prefix });

  if (!backups.length) {
    console.error(`No backups found under "${prefix}" in bucket ${process.env.S3_BUCKET}.`);
    console.error('If you backed up to a different prefix, pass it: npm run restore -- --prefix your-prefix/ --list');
    process.exit(1);
  }

  if (has('--list') || (!has('--latest') && !val('--key'))) {
    console.log(`${backups.length} backup(s) under ${prefix}:\n`);
    for (const b of backups) {
      console.log(`  ${b.key}`);
      console.log(`      ${new Date(b.createdAt).toISOString()}  ${b.rows} rows  ${b.tables} tables  ${fmtBytes(b.bytes)}`);
    }
    console.log('\nRestore with:  npm run restore -- --latest');
    return;
  }

  const key = val('--key') ?? backups[0].key;
  const chosen = backups.find((b) => b.key === key);
  if (!chosen) {
    console.error(`No backup with key ${key}. Run with --list.`);
    process.exit(1);
  }

  console.log(`Verifying ${key} ...`);
  const { manifest } = await verifyBackup(key);
  console.log(`  ok: ${manifest.rows} rows across ${Object.keys(manifest.tables).length} tables, ` +
              `written ${new Date(manifest.createdAt).toISOString()} by Seamless ${manifest.appVersion}`);

  if (has('--verify-only')) {
    console.log('\n--verify-only: database untouched.');
    return;
  }

  if (!(await databaseIsEmpty()) && !has('--force')) {
    console.error('\nRefusing to restore: this database still has users, and restoring TRUNCATES every table.');
    console.error('Re-run with --force if you really mean to overwrite it.');
    process.exit(1);
  }

  console.log(`\nRestoring ${key} (this truncates every table) ...`);
  const report = await restoreBackup(key);
  console.log(`  restored ${report.rows} rows`);
  for (const [t, n] of Object.entries(report.tables).filter(([, n]) => n > 0).sort()) console.log(`      ${t}: ${n}`);
  if (report.skippedColumns.length) {
    console.log(`\n  skipped (not in this schema version): ${report.skippedColumns.join(', ')}`);
  }

  // the mail was never in the backup — only the pointer to it. Say plainly whether the
  // rebuilt server can actually reach the blobs, rather than letting it surface as 404s later
  const { mailStore, blobs } = report;
  console.log(`\nMail blobs: bucket "${mailStore.bucket}" at ${mailStore.endpoint}` +
              `${mailStore.adopted ? ' (from the backup — no S3_* needed)' : ' (from your environment)'}`);
  if (!blobs.checked) {
    console.log('  nothing archived yet, nothing to check.');
  } else if (blobs.ok) {
    console.log(`  reachable: fetched ${blobs.key} and its checksum matches.`);
  } else {
    console.log(`  UNREACHABLE: ${blobs.error}`);
    console.log('  The database is restored, but message bodies will not open until this bucket is reachable.');
    console.log('  Set S3_BUCKET / S3_ACCESS_KEY / S3_SECRET_KEY to the mail bucket and restart.');
  }

  console.log('\nDone. Start the server and log in with your existing credentials.');
}

main()
  .catch((err) => { console.error(`\nrestore failed: ${err?.message ?? err}`); process.exit(1); })
  .finally(() => pool.end());
