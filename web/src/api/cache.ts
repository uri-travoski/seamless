import { openDB, type IDBPDatabase } from 'idb';
import type { ApiEmail, ApiEmailBody, ApiMailbox } from '@seamless/shared';

let dbp: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  dbp ??= openDB('seamless', 1, {
    upgrade(db) {
      db.createObjectStore('emails');
      db.createObjectStore('queries');
      db.createObjectStore('bodies');
      db.createObjectStore('misc');
    },
  });
  return dbp;
}

export interface CachedQuery { ids: string[]; total: number; state: string; ts: number }

export const cache = {
  async putEmails(emails: ApiEmail[]): Promise<void> {
    const db = await getDb();
    const tx = db.transaction('emails', 'readwrite');
    for (const e of emails) void tx.store.put(e, e.id);
    await tx.done;
  },
  async getEmails(ids: string[]): Promise<(ApiEmail | undefined)[]> {
    const db = await getDb();
    return Promise.all(ids.map((id) => db.get('emails', id)));
  },
  async putQuery(key: string, q: CachedQuery): Promise<void> {
    const db = await getDb();
    await db.put('queries', q, key);
  },
  async getQuery(key: string): Promise<CachedQuery | undefined> {
    const db = await getDb();
    return db.get('queries', key);
  },
  async putBody(id: string, body: ApiEmailBody): Promise<void> {
    const db = await getDb();
    await db.put('bodies', body, id);
  },
  async getBody(id: string): Promise<ApiEmailBody | undefined> {
    const db = await getDb();
    return db.get('bodies', id);
  },
  async putMailboxes(boxes: ApiMailbox[]): Promise<void> {
    const db = await getDb();
    await db.put('misc', boxes, 'mailboxes');
  },
  async getMailboxes(): Promise<ApiMailbox[] | undefined> {
    const db = await getDb();
    return db.get('misc', 'mailboxes');
  },
  async clear(): Promise<void> {
    const db = await getDb();
    for (const store of ['emails', 'queries', 'bodies', 'misc']) await db.clear(store);
  },
};
