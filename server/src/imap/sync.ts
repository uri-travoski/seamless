import { ImapFlow } from 'imapflow';
import { EventEmitter } from 'node:events';
import { q, one, run, bumpState } from '../db.ts';
import { getBlob } from '../s3.ts';
import { detectRole } from './roles.ts';
import { ingestMessage, deleteMessageRow, setFlagOpEnqueuer } from '../mail/ingest.ts';
import { accountAuth } from '../oauth.ts';

const POLL_MS = 45_000;
const BATCH = 50;

export interface AccountRow {
  id: number; user_id: number; kind: string; name: string; email: string; aliases: string;
  imap_host: string; imap_port: number; imap_secure: boolean; imap_user: string; imap_pass_enc: string;
  smtp_host: string; smtp_port: number; smtp_secure: boolean; smtp_user: string; smtp_pass_enc: string;
  color: string; signature: string; sent_copy: boolean; ai_categorize: boolean; enabled: boolean;
  safe_delete_enabled: boolean; safe_delete_mode: string; safe_delete_grace_days: number;
}

export interface NewMailEvent {
  accountId: number;
  userId: number;
  rowId: number;
  mailboxRole: string | null;
  from: string;
  subject: string;
  aiCategorize: boolean;
}

class AccountSyncer extends EventEmitter {
  private running = false;
  private waker: (() => void) | null = null;
  private client: ImapFlow | null = null;

  constructor(public account: AccountRow) { super(); }

  kick(): void { this.waker?.(); }

  stop(): void {
    this.running = false;
    this.kick();
    this.client?.logout().catch(() => {});
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  private log(msg: string): void {
    console.log(`[sync:${this.account.email}] ${msg}`);
  }

  private async loop(): Promise<void> {
    let backoff = 2000;
    while (this.running) {
      try {
        this.client = new ImapFlow({
          host: this.account.imap_host,
          port: this.account.imap_port,
          secure: !!this.account.imap_secure,
          auth: await accountAuth(this.account),
          logger: false,
        });
        const client = this.client;
        client.on('exists', () => this.kick());
        client.on('expunge', () => this.kick());
        client.on('flags', () => this.kick());
        client.on('error', () => this.kick());
        await client.connect();
        this.log('connected');
        backoff = 2000;

        while (this.running && client.usable) {
          await this.flushOps(client);
          const inboxPath = await this.syncAllMailboxes(client);
          this.emit('synced', this.account.id);
          // idle on INBOX until event, op kick, or poll timeout
          if (this.running && client.usable && inboxPath) {
            const lock = await client.getMailboxLock(inboxPath);
            try {
              await new Promise<void>((resolve) => {
                const t = setTimeout(resolve, POLL_MS);
                this.waker = () => { clearTimeout(t); this.waker = null; resolve(); };
              });
            } finally {
              this.waker = null;
              lock.release();
            }
          }
        }
        await client.logout().catch(() => {});
      } catch (err: any) {
        this.log(`error: ${err?.message ?? err}`);
        if (!this.running) break;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  /** Create standard role folders (Sent/Drafts/Trash/Junk/Archive) if the server lacks them. */
  private async ensureStandardFolders(client: ImapFlow, listed: Awaited<ReturnType<ImapFlow['list']>>): Promise<boolean> {
    const haveRoles = new Set<string>();
    for (const mb of listed) {
      const role = detectRole(mb.path, mb.name, (mb as any).specialUse);
      if (role) haveRoles.add(role);
    }
    const wanted: [string, string][] = [['sent', 'Sent'], ['drafts', 'Drafts'], ['scheduled', 'Scheduled'], ['trash', 'Trash'], ['junk', 'Junk'], ['archive', 'Archive']];
    let created = false;
    for (const [role, name] of wanted) {
      if (haveRoles.has(role)) continue;
      try {
        await client.mailboxCreate(name);
        created = true;
        this.log(`created missing ${name} folder`);
      } catch (err: any) {
        // AlreadyExists or hierarchy quirk — ignore, next list() picks it up
        this.log(`could not create ${name}: ${err?.message ?? err}`);
      }
    }
    return created;
  }

  /** Sync mailbox list + every mailbox; returns INBOX path. */
  private async syncAllMailboxes(client: ImapFlow): Promise<string | null> {
    let listed = await client.list();
    if (await this.ensureStandardFolders(client, listed)) {
      listed = await client.list();
    }
    let inboxPath: string | null = null;
    const seenPaths = new Set<string>();

    for (const mb of listed) {
      if (mb.flags?.has('\\Noselect') || mb.flags?.has('\\NonExistent')) continue;
      const specialUse = (mb as any).specialUse as string | undefined;
      const role = detectRole(mb.path, mb.name, specialUse);
      if (role === 'inbox') inboxPath = mb.path;
      seenPaths.add(mb.path);
      await run(`
        INSERT INTO mailboxes(account_id, path, delimiter, role, name) VALUES (?,?,?,?,?)
        ON CONFLICT(account_id, path) DO UPDATE SET role = excluded.role, name = excluded.name, delimiter = excluded.delimiter
      `, [this.account.id, mb.path, mb.delimiter ?? '/', role, mb.name]);
    }
    // drop mailboxes that no longer exist server-side
    const stale = await q<{ id: number; path: string }>('SELECT id, path FROM mailboxes WHERE account_id = ?', [this.account.id]);
    for (const s of stale) {
      if (!seenPaths.has(s.path)) await run('DELETE FROM mailboxes WHERE id = ?', [s.id]);
    }

    const boxes = await q<{ id: number; path: string; role: string | null; uidvalidity: number }>(
      'SELECT id, path, role, uidvalidity FROM mailboxes WHERE account_id = ?', [this.account.id]);
    for (const box of boxes) {
      if (!this.running || !client.usable) break;
      try {
        await this.syncMailbox(client, box);
      } catch (err: any) {
        this.log(`mailbox ${box.path} sync error: ${err?.message ?? err}`);
      }
    }
    return inboxPath;
  }

  private async syncMailbox(client: ImapFlow, box: { id: number; path: string; role: string | null; uidvalidity: number }): Promise<void> {
    const lock = await client.getMailboxLock(box.path);
    try {
      const mbox = client.mailbox;
      if (!mbox || typeof mbox === 'boolean') return;
      const uidvalidity = Number(mbox.uidValidity ?? 0);
      if (uidvalidity !== box.uidvalidity) {
        if (box.uidvalidity !== 0) {
          this.log(`uidvalidity changed for ${box.path}; resyncing`);
          const rows = await q<{ id: number }>('SELECT id FROM messages WHERE mailbox_id = ?', [box.id]);
          for (const r of rows) await deleteMessageRow(r.id);
        }
        await run('UPDATE mailboxes SET uidvalidity = ? WHERE id = ?', [uidvalidity, box.id]);
      }

      // full uid+flags snapshot (fine for typical mailbox sizes; batched source fetch below)
      const serverFlags = new Map<number, Set<string>>();
      if (mbox.exists > 0) {
        for await (const msg of client.fetch('1:*', { uid: true, flags: true }, { uid: true })) {
          serverFlags.set(msg.uid, msg.flags ?? new Set());
        }
      }

      const localRows = await q<{ id: number; uid: number; unread: boolean; flagged: boolean; answered: boolean; draft: boolean; origin_state: string }>(
        'SELECT id, uid, unread, flagged, answered, draft, origin_state FROM messages WHERE mailbox_id = ?', [box.id]);
      const localByUid = new Map(localRows.map((r) => [r.uid, r]));

      let changed = false;

      // deletions — never for messages Seamless itself removed at the origin (safe delete):
      // the local copy is the record now
      for (const row of localRows) {
        if (row.origin_state !== 'present') continue;
        if (!serverFlags.has(row.uid)) { await deleteMessageRow(row.id); changed = true; }
      }

      // flag updates
      for (const [uid, flags] of serverFlags) {
        const row = localByUid.get(uid);
        if (!row) continue;
        const unread = !flags.has('\\Seen');
        const flagged = flags.has('\\Flagged');
        const answered = flags.has('\\Answered');
        if (unread !== row.unread || flagged !== row.flagged || answered !== row.answered) {
          await run('UPDATE messages SET unread = ?, flagged = ?, answered = ? WHERE id = ?', [unread, flagged, answered, row.id]);
          changed = true;
        }
      }

      // new messages, newest first
      const newUids = [...serverFlags.keys()].filter((uid) => !localByUid.has(uid)).sort((a, b) => b - a);
      const isFirstSync = localRows.length === 0 && box.uidvalidity === 0;
      for (let i = 0; i < newUids.length; i += BATCH) {
        if (!this.running || !client.usable) break;
        const chunk = newUids.slice(i, i + BATCH);
        for await (const msg of client.fetch(chunk.join(','), { uid: true, flags: true, internalDate: true, source: true }, { uid: true })) {
          if (!msg.source) continue;
          const result = await ingestMessage({
            accountId: this.account.id,
            mailboxId: box.id,
            uid: msg.uid,
            raw: Buffer.from(msg.source),
            flags: msg.flags ?? new Set(),
            internalDate: msg.internalDate ? new Date(msg.internalDate) : null,
            isLive: !isFirstSync,
          });
          if (result) {
            changed = true;
            if (result.isInboxLive) {
              const moveAction = result.filterActions.find((a) => a.type === 'move' || a.type === 'delete');
              if (moveAction) {
                await enqueueOp(this.account.id, 'move', {
                  mailboxId: box.id, uid: msg.uid,
                  targetRole: moveAction.type === 'delete' ? 'trash' : moveAction.value,
                });
              }
              this.emit('newMail', {
                accountId: this.account.id,
                userId: this.account.user_id,
                rowId: result.rowId,
                mailboxRole: box.role,
                from: result.parsed.from?.text ?? '',
                subject: result.parsed.subject ?? '',
                aiCategorize: !!this.account.ai_categorize,
              } satisfies NewMailEvent);
            }
          }
        }
      }

      if (changed) { await bumpState(); this.emit('changed', this.account.user_id); }
    } finally {
      lock.release();
    }
  }

  /** Execute queued IMAP write ops for this account. */
  private async flushOps(client: ImapFlow): Promise<void> {
    const ops = await q<{ id: number; op: string; payload: string; attempts: number }>(
      'SELECT * FROM op_queue WHERE account_id = ? ORDER BY id', [this.account.id]);
    for (const op of ops) {
      if (!client.usable) return;
      const payload = JSON.parse(op.payload);
      try {
        await this.execOp(client, op.op, payload);
        await run('DELETE FROM op_queue WHERE id = ?', [op.id]);
      } catch (err: any) {
        this.log(`op ${op.op} failed: ${err?.message ?? err}`);
        if (op.attempts >= 4) {
          await run('DELETE FROM op_queue WHERE id = ?', [op.id]);
        } else {
          await run('UPDATE op_queue SET attempts = attempts + 1 WHERE id = ?', [op.id]);
        }
      }
    }
  }

  private async mailboxPath(mailboxId: number): Promise<string | null> {
    const row = await one<{ path: string }>('SELECT path FROM mailboxes WHERE id = ?', [mailboxId]);
    return row?.path ?? null;
  }

  private async rolePath(role: string): Promise<string | null> {
    const row = await one<{ path: string }>('SELECT path FROM mailboxes WHERE account_id = ? AND role = ?', [this.account.id, role]);
    return row?.path ?? null;
  }

  private async execOp(client: ImapFlow, op: string, p: any): Promise<void> {
    switch (op) {
      case 'setFlags': {
        const path = await this.mailboxPath(p.mailboxId);
        if (!path) return;
        const lock = await client.getMailboxLock(path);
        try {
          if (p.add?.length) await client.messageFlagsAdd(String(p.uid), p.add, { uid: true });
          if (p.remove?.length) await client.messageFlagsRemove(String(p.uid), p.remove, { uid: true });
        } finally { lock.release(); }
        break;
      }
      case 'move': {
        const src = await this.mailboxPath(p.mailboxId);
        const dst = p.targetMailboxId ? await this.mailboxPath(p.targetMailboxId) : await this.rolePath(p.targetRole);
        if (!src || !dst || src === dst) return;
        const lock = await client.getMailboxLock(src);
        try {
          await client.messageMove(String(p.uid), dst, { uid: true });
        } finally { lock.release(); }
        break;
      }
      case 'expunge': {
        const path = await this.mailboxPath(p.mailboxId);
        if (!path) return;
        const lock = await client.getMailboxLock(path);
        try {
          await client.messageDelete(String(p.uid), { uid: true });
        } finally { lock.release(); }
        break;
      }
      case 'append': {
        // raw stored in S3 to keep the queue small
        const raw = await getBlob(p.s3Key);
        const path = p.mailboxPath ?? (p.targetRole ? await this.rolePath(p.targetRole) : null);
        if (!path) return;
        await client.append(path, raw, p.flags ?? []);
        break;
      }
    }
  }
}

export async function enqueueOp(accountId: number, op: string, payload: unknown): Promise<void> {
  await run('INSERT INTO op_queue(account_id, op, payload, created_at) VALUES (?,?,?,?)',
    [accountId, op, JSON.stringify(payload), Date.now()]);
  syncManager.kick(accountId);
}

setFlagOpEnqueuer((accountId, payload) => enqueueOp(accountId, 'setFlags', payload));

class SyncManager extends EventEmitter {
  private syncers = new Map<number, AccountSyncer>();

  async startAll(): Promise<void> {
    const accounts = await q<AccountRow>('SELECT * FROM accounts WHERE enabled = true');
    for (const acct of accounts) this.startAccount(acct);
  }

  startAccount(acct: AccountRow): void {
    this.stopAccount(acct.id);
    const syncer = new AccountSyncer(acct);
    syncer.on('newMail', (ev) => this.emit('newMail', ev));
    syncer.on('changed', (userId) => this.emit('changed', userId));
    syncer.on('synced', (id) => this.emit('synced', id));
    this.syncers.set(acct.id, syncer);
    syncer.start();
  }

  stopAccount(accountId: number): void {
    this.syncers.get(accountId)?.stop();
    this.syncers.delete(accountId);
  }

  async restartAccount(accountId: number): Promise<void> {
    const acct = await one<AccountRow>('SELECT * FROM accounts WHERE id = ? AND enabled = true', [accountId]);
    if (acct) this.startAccount(acct);
    else this.stopAccount(accountId);
  }

  kick(accountId?: number): void {
    if (accountId !== undefined) this.syncers.get(accountId)?.kick();
    else for (const s of this.syncers.values()) s.kick();
  }
}

export const syncManager = new SyncManager();
