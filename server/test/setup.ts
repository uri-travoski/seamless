/* Per-test-file setup: ensure the test database exists, then rebuild the schema. */
import pg from 'pg';
import { config } from '../src/config.ts';
import { pool, migrate } from '../src/db.ts';

const url = new URL(config.databaseUrl);
const dbName = url.pathname.slice(1);
if (!/test/.test(dbName)) throw new Error(`refusing to run tests against non-test database "${dbName}"`);

// create the test database if missing (connect to the base "seamless" db to do it)
const adminUrl = new URL(config.databaseUrl);
adminUrl.pathname = '/seamless';
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${dbName}"`);
await admin.end();

await pool.query('DROP SCHEMA public CASCADE');
await pool.query('CREATE SCHEMA public');
await migrate();
