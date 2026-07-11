import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import { q, one } from '../db.ts';
import { config } from '../config.ts';
import { getBlob } from '../s3.ts';
import { facadeLogin } from './auth.ts';
import { setKeywords, moveEmail, destroyEmail, setLabels } from '../mail/store.ts';
import { ingestMessage } from '../mail/ingest.ts';

/**
 * Minimal IMAP4rev1 facade so standard mail clients (Thunderbird, iOS Mail, K-9…)
 * read the Seamless store directly. Folders = unified role folders + one folder per
 * label ("Labels/<name>"). UID = message row id (stable, monotonic). Writes go through
 * the same store mutations the web UI uses, so flags/moves propagate to origin servers.
 * Auth = app passwords (Settings → Devices).
 */

const ROLE_FOLDERS: [string, string][] = [
  ['INBOX', 'inbox'], ['Sent', 'sent'], ['Drafts', 'drafts'], ['Scheduled', 'scheduled'],
  ['Archive', 'archive'], ['Junk', 'junk'], ['Trash', 'trash'],
];

interface Folder { name: string; role?: string; labelId?: number; uidvalidity: number }

interface MsgMeta {
  id: number; unread: boolean; flagged: boolean; answered: boolean; draft: boolean;
  date: number; size: number; subject: string; from_name: string; from_addr: string;
  to_json: string; cc_json: string; message_id: string | null; in_reply_to: string | null;
  s3_key: string | null; thread_id: string;
}

async function listFolders(userId: number): Promise<Folder[]> {
  const labels = await q<{ id: number; name: string }>('SELECT id, name FROM labels WHERE user_id = ? ORDER BY name', [userId]);
  return [
    ...ROLE_FOLDERS.map(([name, role]) => ({ name, role, uidvalidity: 1 })),
    ...labels.map((l) => ({ name: `Labels/${l.name}`, labelId: l.id, uidvalidity: 100000 + l.id })),
  ];
}

async function folderMessages(userId: number, f: Folder): Promise<MsgMeta[]> {
  const cols = `m.id, m.unread, m.flagged, m.answered, m.draft, m.date, m.size, m.subject,
    m.from_name, m.from_addr, m.to_json, m.cc_json, m.message_id, m.in_reply_to, m.s3_key, m.thread_id`;
  if (f.role) {
    return q<MsgMeta>(`
      SELECT ${cols} FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
      WHERE m.user_id = ? AND mb.role = ? ORDER BY m.id
    `, [userId, f.role]);
  }
  return q<MsgMeta>(`
    SELECT ${cols} FROM messages m
    JOIN message_labels ml ON ml.message_id = m.id
    JOIN mailboxes mb ON mb.id = m.mailbox_id
    WHERE m.user_id = ? AND ml.label_id = ? AND (mb.role IS NULL OR mb.role NOT IN ('trash','junk'))
    ORDER BY m.id
  `, [userId, f.labelId]);
}

// ---------- wire helpers ----------

const quote = (s: string) => `"${s.replace(/[\\"]/g, (c) => '\\' + c)}"`;
const nilOr = (s: string | null | undefined) => (s ? quote(s) : 'NIL');
const literal = (buf: Buffer) => `{${buf.length}}\r\n`;

function imapDate(ms: number): string {
  const d = new Date(ms);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}-${mon}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

function addrList(json: string): string {
  const list = JSON.parse(json || '[]') as { name: string; email: string }[];
  if (list.length === 0) return 'NIL';
  return '(' + list.map((a) => {
    const [mbox, host] = (a.email ?? '').split('@');
    return `(${nilOr(a.name)} NIL ${nilOr(mbox)} ${nilOr(host)})`;
  }).join('') + ')';
}

function envelope(m: MsgMeta): string {
  const from = `((${nilOr(m.from_name)} NIL ${nilOr(m.from_addr.split('@')[0])} ${nilOr(m.from_addr.split('@')[1])}))`;
  return `(${nilOr(new Date(m.date).toUTCString())} ${nilOr(m.subject)} ${from} ${from} ${from} ${addrList(m.to_json)} ${addrList(m.cc_json)} NIL ${nilOr(m.in_reply_to)} ${nilOr(m.message_id)})`;
}

function flagString(m: MsgMeta, deleted: Set<number>): string {
  const flags: string[] = [];
  if (!m.unread) flags.push('\\Seen');
  if (m.flagged) flags.push('\\Flagged');
  if (m.answered) flags.push('\\Answered');
  if (m.draft) flags.push('\\Draft');
  if (deleted.has(m.id)) flags.push('\\Deleted');
  return `(${flags.join(' ')})`;
}

/** Parse an IMAP sequence-set against a snapshot (uid mode uses row ids). */
function resolveSet(set: string, snapshot: MsgMeta[], uidMode: boolean): MsgMeta[] {
  const out = new Map<number, MsgMeta>();
  const maxUid = snapshot.length ? snapshot[snapshot.length - 1].id : 0;
  for (const part of set.split(',')) {
    if (part.includes(':')) {
      let [a, b] = part.split(':').map((x) => (x === '*' ? (uidMode ? maxUid : snapshot.length) : Number(x)));
      if (a > b) [a, b] = [b, a];
      for (let i = 0; i < snapshot.length; i++) {
        const key = uidMode ? snapshot[i].id : i + 1;
        if (key >= a && key <= b) out.set(snapshot[i].id, snapshot[i]);
      }
    } else {
      const n = part === '*' ? (uidMode ? maxUid : snapshot.length) : Number(part);
      if (uidMode) { const hit = snapshot.find((m) => m.id === n); if (hit) out.set(hit.id, hit); }
      else if (snapshot[n - 1]) out.set(snapshot[n - 1].id, snapshot[n - 1]);
    }
  }
  return [...out.values()];
}

/** Split a command line into atoms, honouring quoted strings and parenthesised lists. */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|\(([^)]*)\)|(\[[^\]]*\])|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m[1] !== undefined) tokens.push(m[1].replace(/\\(.)/g, '$1'));
    else if (m[2] !== undefined) tokens.push(`(${m[2]})`);
    else if (m[3] !== undefined) tokens.push(m[3]);
    else tokens.push(m[4]);
  }
  return tokens;
}

class ImapSession {
  private buf = Buffer.alloc(0);
  private literalNeed = 0;
  private queue: Promise<void> = Promise.resolve(); // commands must run in order
  private pendingLine: Buffer[] = [];
  private userId: number | null = null;
  private folder: Folder | null = null;
  private snapshot: MsgMeta[] = [];
  private deleted = new Set<number>();
  private idleTag: string | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private socket: net.Socket) {
    socket.on('data', (d) => this.onData(d));
    socket.on('error', () => socket.destroy());
    socket.on('close', () => { if (this.idleTimer) clearInterval(this.idleTimer); });
    this.write('* OK [CAPABILITY IMAP4rev1 LITERAL+ IDLE MOVE UIDPLUS] Seamless ready\r\n');
  }

  private write(s: string | Buffer): void {
    if (!this.socket.destroyed) this.socket.write(s);
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    while (true) {
      if (this.literalNeed > 0) {
        if (this.buf.length < this.literalNeed) return;
        this.pendingLine.push(this.buf.subarray(0, this.literalNeed));
        this.buf = this.buf.subarray(this.literalNeed);
        this.literalNeed = 0;
        continue;
      }
      const nl = this.buf.indexOf('\n');
      if (nl === -1) return;
      const line = this.buf.subarray(0, nl + 1);
      this.buf = this.buf.subarray(nl + 1);
      const text = line.toString('utf8').replace(/\r?\n$/, '');
      const lit = text.match(/\{(\d+)(\+)?\}$/);
      if (lit) {
        this.pendingLine.push(Buffer.from(text.replace(/\{\d+\+?\}$/, ''), 'utf8'));
        this.literalNeed = Number(lit[1]);
        if (!lit[2]) this.write('+ OK\r\n');
        continue;
      }
      this.pendingLine.push(Buffer.from(text, 'utf8'));
      const parts = this.pendingLine;
      this.pendingLine = [];
      this.queue = this.queue.then(() => this.handle(parts)).catch((err) => {
        console.error('[imapd]', err?.message ?? err);
        this.write('* BAD internal error\r\n');
      });
    }
  }

  /** parts: text fragments interleaved with literal buffers (literals only in LOGIN/APPEND). */
  private async handle(parts: Buffer[]): Promise<void> {
    const first = parts[0].toString('utf8');

    if (this.idleTag) {
      if (/^done$/i.test(first.trim())) {
        this.write(`${this.idleTag} OK IDLE terminated\r\n`);
        this.idleTag = null;
        if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
      }
      return;
    }

    const sp = first.indexOf(' ');
    if (sp === -1) { this.write('* BAD missing command\r\n'); return; }
    const tag = first.slice(0, sp);
    const rest = first.slice(sp + 1);
    const cmdMatch = rest.match(/^(UID\s+)?(\w+)\s*/i);
    if (!cmdMatch) { this.write(`${tag} BAD unknown\r\n`); return; }
    const uidMode = !!cmdMatch[1];
    const cmd = cmdMatch[2].toUpperCase();
    const argsText = rest.slice(cmdMatch[0].length);

    try {
      switch (cmd) {
        case 'CAPABILITY':
          this.write('* CAPABILITY IMAP4rev1 LITERAL+ IDLE MOVE UIDPLUS\r\n');
          this.write(`${tag} OK done\r\n`);
          return;
        case 'NOOP':
          if (this.folder && this.userId) await this.refresh(true);
          this.write(`${tag} OK done\r\n`);
          return;
        case 'LOGOUT':
          this.write('* BYE bye\r\n');
          this.write(`${tag} OK done\r\n`);
          this.socket.end();
          return;
        case 'LOGIN': {
          const toks = tokenize(argsText);
          const user = toks[0] ?? '';
          const pass = parts.length > 1 ? parts[parts.length - 1].toString('utf8') : toks[1] ?? '';
          const auth = await facadeLogin(user, pass, 'imap');
          if (!auth) { this.write(`${tag} NO invalid credentials (use an app password from Settings > Devices)\r\n`); return; }
          this.userId = auth.userId;
          this.write(`${tag} OK logged in\r\n`);
          return;
        }
      }

      if (!this.userId) { this.write(`${tag} NO not authenticated\r\n`); return; }

      switch (cmd) {
        case 'LIST': case 'LSUB': {
          const toks = tokenize(argsText);
          const ref = toks[0] ?? '';
          const pattern = toks[1] ?? '*';
          if (pattern === '') {
            // namespace probe: answer with the hierarchy root only
            this.write(`* ${cmd} (\\Noselect) "/" ""\r\n`);
            this.write(`${tag} OK done\r\n`);
            return;
          }
          const glob = (ref + pattern)
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/%/g, '[^/]*');
          const re = new RegExp(`^${glob}$`, 'i');
          const folders = (await listFolders(this.userId)).filter((f) => re.test(f.name));
          for (const f of folders) {
            const attrs = f.name === 'Trash' ? '\\Trash' : f.name === 'Sent' ? '\\Sent' : f.name === 'Drafts' ? '\\Drafts' : f.name === 'Junk' ? '\\Junk' : f.name === 'Archive' ? '\\Archive' : '';
            this.write(`* ${cmd} (${attrs}) "/" ${quote(f.name)}\r\n`);
          }
          this.write(`${tag} OK done\r\n`);
          return;
        }
        case 'SUBSCRIBE': case 'UNSUBSCRIBE':
          this.write(`${tag} OK done\r\n`);
          return;
        case 'STATUS': {
          const name = tokenize(argsText)[0];
          const f = (await listFolders(this.userId)).find((x) => x.name === name);
          if (!f) { this.write(`${tag} NO no such folder\r\n`); return; }
          const msgs = await folderMessages(this.userId, f);
          const unseen = msgs.filter((m) => m.unread).length;
          this.write(`* STATUS ${quote(name)} (MESSAGES ${msgs.length} UNSEEN ${unseen} UIDNEXT ${(msgs.at(-1)?.id ?? 0) + 1} UIDVALIDITY ${f.uidvalidity})\r\n`);
          this.write(`${tag} OK done\r\n`);
          return;
        }
        case 'SELECT': case 'EXAMINE': {
          const name = tokenize(argsText)[0];
          const f = (await listFolders(this.userId)).find((x) => x.name === name);
          if (!f) { this.write(`${tag} NO no such folder\r\n`); return; }
          this.folder = f;
          this.deleted.clear();
          this.snapshot = await folderMessages(this.userId, f);
          const unseenIdx = this.snapshot.findIndex((m) => m.unread);
          this.write('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n');
          this.write(`* ${this.snapshot.length} EXISTS\r\n`);
          this.write('* 0 RECENT\r\n');
          if (unseenIdx >= 0) this.write(`* OK [UNSEEN ${unseenIdx + 1}]\r\n`);
          this.write(`* OK [UIDVALIDITY ${f.uidvalidity}] UIDs valid\r\n`);
          this.write(`* OK [UIDNEXT ${(this.snapshot.at(-1)?.id ?? 0) + 1}]\r\n`);
          this.write('* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen)] limited\r\n');
          this.write(`${tag} OK [${cmd === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] ${cmd} done\r\n`);
          return;
        }
        case 'CLOSE':
          await this.expunge(false);
          this.folder = null;
          this.write(`${tag} OK done\r\n`);
          return;
        case 'EXPUNGE':
          await this.expunge(true);
          this.write(`${tag} OK done\r\n`);
          return;
        case 'IDLE':
          this.idleTag = tag;
          this.write('+ idling\r\n');
          this.idleTimer = setInterval(() => void this.refresh(true).catch(() => {}), 15_000);
          return;
        case 'FETCH':
          await this.fetch(tag, argsText, uidMode);
          return;
        case 'STORE':
          await this.store(tag, argsText, uidMode);
          return;
        case 'SEARCH':
          await this.search(tag, argsText, uidMode);
          return;
        case 'COPY': case 'MOVE':
          await this.copyMove(tag, argsText, uidMode, cmd === 'MOVE');
          return;
        case 'APPEND':
          await this.append(tag, argsText, parts);
          return;
        default:
          this.write(`${tag} BAD ${cmd} not supported\r\n`);
      }
    } catch (err: any) {
      this.write(`${tag} NO ${String(err?.message ?? 'error').replace(/[\r\n]/g, ' ')}\r\n`);
    }
  }

  private async refresh(notify: boolean): Promise<void> {
    if (!this.folder || !this.userId) return;
    const before = this.snapshot.length;
    this.snapshot = await folderMessages(this.userId, this.folder);
    if (notify && this.snapshot.length !== before) {
      this.write(`* ${this.snapshot.length} EXISTS\r\n`);
    }
  }

  private async expunge(notify: boolean): Promise<void> {
    if (!this.userId) return;
    const doomed = [...this.deleted];
    this.deleted.clear();
    for (const id of doomed) {
      await destroyEmail(this.userId, `m${id}`);
      const seq = this.snapshot.findIndex((m) => m.id === id);
      if (seq >= 0) {
        this.snapshot.splice(seq, 1);
        if (notify) this.write(`* ${seq + 1} EXPUNGE\r\n`);
      }
    }
  }

  private async fetch(tag: string, argsText: string, uidMode: boolean): Promise<void> {
    const m = argsText.match(/^(\S+)\s+(.*)$/s);
    if (!m || !this.folder) { this.write(`${tag} BAD fetch args\r\n`); return; }
    const targets = resolveSet(m[1], this.snapshot, uidMode);
    const itemsRaw = m[2].trim().replace(/^\(|\)$/g, '');
    const wantsBody = /BODY(?:\.PEEK)?\[/i.test(itemsRaw) || /RFC822(?!\.SIZE)/i.test(itemsRaw);
    const bodySection = itemsRaw.match(/BODY(?:\.PEEK)?\[([^\]]*)\]/i)?.[1] ?? '';

    for (const msg of targets) {
      const seq = this.snapshot.findIndex((x) => x.id === msg.id) + 1;
      const out: string[] = [`UID ${msg.id}`];
      if (/FLAGS/i.test(itemsRaw)) out.push(`FLAGS ${flagString(msg, this.deleted)}`);
      if (/INTERNALDATE/i.test(itemsRaw)) out.push(`INTERNALDATE "${imapDate(msg.date)}"`);
      if (/RFC822\.SIZE/i.test(itemsRaw)) out.push(`RFC822.SIZE ${msg.size}`);
      if (/ENVELOPE/i.test(itemsRaw)) out.push(`ENVELOPE ${envelope(msg)}`);
      if (/BODYSTRUCTURE/i.test(itemsRaw)) {
        out.push(`BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" ${msg.size} ${Math.max(1, Math.ceil(msg.size / 60))})`);
      }

      let bodyBuf: Buffer | null = null;
      let bodyLabel = '';
      if (wantsBody && msg.s3_key) {
        try {
          const raw = await getBlob(msg.s3_key);
          const section = bodySection.toUpperCase();
          if (section.startsWith('HEADER.FIELDS')) {
            const fields = (bodySection.match(/\(([^)]*)\)/)?.[1] ?? '').toLowerCase().split(/\s+/).filter(Boolean);
            const headerEnd = raw.indexOf('\r\n\r\n');
            const headerText = raw.subarray(0, headerEnd === -1 ? raw.length : headerEnd).toString('utf8');
            const lines = headerText.split(/\r\n/);
            const keep: string[] = [];
            let keeping = false;
            for (const line of lines) {
              if (/^\s/.test(line)) { if (keeping) keep.push(line); continue; }
              const name = line.split(':')[0]?.toLowerCase();
              keeping = fields.includes(name);
              if (keeping) keep.push(line);
            }
            bodyBuf = Buffer.from(keep.join('\r\n') + '\r\n\r\n', 'utf8');
            bodyLabel = `BODY[${bodySection}]`;
          } else if (section === 'HEADER') {
            const headerEnd = raw.indexOf('\r\n\r\n');
            bodyBuf = raw.subarray(0, (headerEnd === -1 ? raw.length : headerEnd + 4));
            bodyLabel = 'BODY[HEADER]';
          } else if (section === 'TEXT') {
            const headerEnd = raw.indexOf('\r\n\r\n');
            bodyBuf = headerEnd === -1 ? raw : raw.subarray(headerEnd + 4);
            bodyLabel = 'BODY[TEXT]';
          } else {
            bodyBuf = raw;
            bodyLabel = /RFC822(?!\.)/i.test(itemsRaw) && !/BODY/i.test(itemsRaw) ? 'RFC822' : 'BODY[]';
          }
          // fetching the full body marks read (unless PEEK)
          if (!/PEEK/i.test(itemsRaw) && msg.unread && this.userId) {
            await setKeywords(this.userId, `m${msg.id}`, { $seen: true });
            msg.unread = false;
          }
        } catch { /* blob missing */ }
      }

      let line = `* ${seq} FETCH (${out.join(' ')}`;
      if (bodyBuf) {
        this.write(line + ` ${bodyLabel} ` + literal(bodyBuf));
        this.write(bodyBuf);
        this.write(')\r\n');
      } else {
        this.write(line + ')\r\n');
      }
    }
    this.write(`${tag} OK FETCH done\r\n`);
  }

  private async store(tag: string, argsText: string, uidMode: boolean): Promise<void> {
    const m = argsText.match(/^(\S+)\s+([+-]?)FLAGS(?:\.SILENT)?\s+\(?([^)]*)\)?/i);
    if (!m || !this.userId) { this.write(`${tag} BAD store args\r\n`); return; }
    const targets = resolveSet(m[1], this.snapshot, uidMode);
    const mode = m[2];
    const flags = m[3].split(/\s+/).filter(Boolean).map((f) => f.toLowerCase());
    const silent = /\.SILENT/i.test(argsText);

    for (const msg of targets) {
      const patch: Record<string, boolean> = {};
      const has = (f: string) => flags.includes(f);
      const val = mode !== '-';
      if (has('\\seen')) { patch.$seen = val; msg.unread = !val; }
      if (has('\\flagged')) { patch.$flagged = val; msg.flagged = val; }
      if (has('\\answered')) { patch.$answered = val; msg.answered = val; }
      if (mode === '' ) { // replace-mode: clear what's absent
        patch.$seen = has('\\seen'); patch.$flagged = has('\\flagged'); patch.$answered = has('\\answered');
        msg.unread = !patch.$seen; msg.flagged = patch.$flagged; msg.answered = patch.$answered;
      }
      if (Object.keys(patch).length) await setKeywords(this.userId, `m${msg.id}`, patch);
      if (has('\\deleted')) { if (val) this.deleted.add(msg.id); else this.deleted.delete(msg.id); }
      if (!silent) {
        const seq = this.snapshot.findIndex((x) => x.id === msg.id) + 1;
        this.write(`* ${seq} FETCH (UID ${msg.id} FLAGS ${flagString(msg, this.deleted)})\r\n`);
      }
    }
    this.write(`${tag} OK STORE done\r\n`);
  }

  private async search(tag: string, argsText: string, uidMode: boolean): Promise<void> {
    const crit = argsText.toUpperCase();
    let hits = this.snapshot;
    if (/\bUNSEEN\b/.test(crit)) hits = hits.filter((m) => m.unread);
    if (/\bSEEN\b/.test(crit) && !/\bUNSEEN\b/.test(crit)) hits = hits.filter((m) => !m.unread);
    if (/\bFLAGGED\b/.test(crit)) hits = hits.filter((m) => m.flagged);
    const since = argsText.match(/SINCE\s+(\d{1,2}-\w{3}-\d{4})/i);
    if (since) {
      const t = Date.parse(since[1].replace(/-/g, ' '));
      if (!isNaN(t)) hits = hits.filter((m) => m.date >= t);
    }
    const hdr = argsText.match(/HEADER\s+Message-ID\s+(\S+)/i);
    if (hdr) hits = hits.filter((m) => (m.message_id ?? '').includes(hdr[1].replace(/"/g, '')));
    const ids = hits.map((m) => uidMode ? m.id : this.snapshot.findIndex((x) => x.id === m.id) + 1);
    this.write(`* SEARCH${ids.length ? ' ' + ids.join(' ') : ''}\r\n`);
    this.write(`${tag} OK SEARCH done\r\n`);
  }

  private async copyMove(tag: string, argsText: string, uidMode: boolean, move: boolean): Promise<void> {
    const toks = tokenize(argsText);
    if (!this.userId || toks.length < 2) { this.write(`${tag} BAD args\r\n`); return; }
    const targets = resolveSet(toks[0], this.snapshot, uidMode);
    const destName = toks.slice(1).join(' ');
    const folders = await listFolders(this.userId);
    const dest = folders.find((f) => f.name === destName);
    if (!dest) { this.write(`${tag} NO [TRYCREATE] no such folder\r\n`); return; }

    for (const msg of targets) {
      if (dest.role) {
        await moveEmail(this.userId, `m${msg.id}`, `u:${dest.role}`);
      } else if (dest.labelId) {
        const cur = await q<{ label_id: number }>('SELECT label_id FROM message_labels WHERE message_id = ?', [msg.id]);
        const ids = new Set(cur.map((c) => c.label_id));
        ids.add(dest.labelId);
        if (move && this.folder?.labelId) ids.delete(this.folder.labelId);
        await setLabels(this.userId, `m${msg.id}`, [...ids]);
      }
      if (move && this.folder?.role && dest.role) {
        const seq = this.snapshot.findIndex((x) => x.id === msg.id);
        if (seq >= 0) { this.snapshot.splice(seq, 1); this.write(`* ${seq + 1} EXPUNGE\r\n`); }
      }
    }
    this.write(`${tag} OK ${move ? 'MOVE' : 'COPY'} done\r\n`);
  }

  private async append(tag: string, argsText: string, parts: Buffer[]): Promise<void> {
    if (!this.userId) { this.write(`${tag} NO not authenticated\r\n`); return; }
    const raw = parts.length > 1 ? parts[parts.length - 1] : null;
    if (!raw) { this.write(`${tag} BAD missing literal\r\n`); return; }
    const toks = tokenize(argsText);
    const destName = toks[0];
    const flags = (argsText.match(/\(([^)]*)\)/)?.[1] ?? '').split(/\s+/).filter(Boolean);
    const folders = await listFolders(this.userId);
    const dest = folders.find((f) => f.name === destName);
    if (!dest?.role) { this.write(`${tag} NO can only APPEND to role folders\r\n`); return; }

    const acct = await one<{ id: number }>('SELECT id FROM accounts WHERE user_id = ? AND enabled = true ORDER BY id LIMIT 1', [this.userId]);
    const mailbox = acct ? await one<{ id: number }>('SELECT id FROM mailboxes WHERE account_id = ? AND role = ?', [acct.id, dest.role]) : null;
    if (!acct || !mailbox) { this.write(`${tag} NO no account to store into\r\n`); return; }

    const result = await ingestMessage({
      accountId: acct.id, mailboxId: mailbox.id,
      uid: -Math.floor(Date.now() / 1000), // local-only copy: never propagated to an origin
      raw, flags: new Set(flags), internalDate: new Date(), isLive: false,
    });
    this.write(`${tag} OK [APPENDUID ${dest.uidvalidity} ${result?.rowId ?? 0}] APPEND done\r\n`);
  }
}

export function startImapFacade(port = config.facade.imapPort): net.Server | null {
  if (!config.facade.enabled) return null;
  const useTls = config.facade.tlsKeyFile && config.facade.tlsCertFile;
  const handler = (socket: net.Socket) => new ImapSession(socket);
  const server = useTls
    ? tls.createServer({ key: fs.readFileSync(config.facade.tlsKeyFile), cert: fs.readFileSync(config.facade.tlsCertFile) }, handler)
    : net.createServer(handler);
  server.listen(port, '0.0.0.0', () =>
    console.log(`IMAP facade on :${port}${useTls ? ' (TLS)' : ' (plain — front with a TLS proxy for WAN use)'}`));
  server.on('error', (e) => console.error('[imapd]', e.message));
  return server;
}
