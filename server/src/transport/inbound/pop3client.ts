/**
 * Minimal POP3 client (RFC 1939) over net/tls, with optional STLS. Only what polling needs:
 * connect, auth (USER/PASS with AUTH PLAIN fallback), stat, uidl, retr, dele, quit.
 */
import net from 'node:net';
import tls from 'node:tls';

export class Pop3Error extends Error {}

export interface Pop3Options {
  host: string;
  port: number;
  secure: boolean;            // implicit TLS (995)
  starttls?: boolean;         // upgrade with STLS when the server offers it (port 110)
  timeoutMs?: number;         // per-response timeout, default 30 s
  rejectUnauthorized?: boolean;
}

export class Pop3Client {
  private sock!: net.Socket;
  private buf: Buffer = Buffer.alloc(0);
  private wake: (() => void) | null = null;
  private err: Error | null = null;
  private closed = false;
  private readonly timeout: number;

  constructor(private opts: Pop3Options) { this.timeout = opts.timeoutMs ?? 30_000; }

  private attach(sock: net.Socket): void {
    this.sock = sock;
    sock.on('data', (d: Buffer) => { this.buf = Buffer.concat([this.buf, d]); this.wake?.(); });
    sock.on('error', (e) => { this.err = e; this.wake?.(); });
    sock.on('close', () => { this.closed = true; this.wake?.(); });
  }

  private pull<T>(extract: () => T | null): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const done = (fn: () => void) => { clearTimeout(timer); this.wake = null; fn(); };
      const timer = setTimeout(() => done(() => { this.sock.destroy(); reject(new Pop3Error('POP3 server timed out')); }), this.timeout);
      const attempt = () => {
        const v = extract();
        if (v !== null) return done(() => resolve(v));
        if (this.err) return done(() => reject(this.err));
        if (this.closed) return done(() => reject(new Pop3Error('POP3 connection closed')));
        this.wake = attempt;
      };
      attempt();
    });
  }

  private line(): Promise<string> {
    return this.pull(() => {
      const i = this.buf.indexOf('\r\n');
      if (i < 0) return null;
      const l = this.buf.subarray(0, i).toString('utf8');
      this.buf = this.buf.subarray(i + 2);
      return l;
    });
  }

  /** Multi-line body up to the lone "." line, dot-unstuffed, CRLF line endings kept. */
  private multi(): Promise<Buffer> {
    return this.pull(() => {
      let end: number, skip: number;
      if (this.buf.subarray(0, 3).toString('latin1') === '.\r\n') { end = 0; skip = 3; }
      else {
        const i = this.buf.indexOf('\r\n.\r\n');
        if (i < 0) return null;
        end = i + 2; skip = i + 5;
      }
      const body = this.buf.subarray(0, end).toString('latin1');
      this.buf = this.buf.subarray(skip);
      const un = body.split('\r\n').map((l) => (l.startsWith('.') ? l.slice(1) : l)).join('\r\n');
      return Buffer.from(un, 'latin1');
    });
  }

  private async status(): Promise<string> {
    const l = await this.line();
    if (l.startsWith('+OK')) return l.slice(3).trim();
    throw new Pop3Error(l.replace(/^-ERR\s*/, '') || 'POP3 error');
  }

  private async cmd(c: string): Promise<string> {
    this.sock.write(c + '\r\n');
    return this.status();
  }

  async connect(): Promise<void> {
    const { host, port } = this.opts;
    const sock: net.Socket = await new Promise((resolve, reject) => {
      const s = this.opts.secure
        ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: this.opts.rejectUnauthorized ?? false })
        : net.connect({ host, port });
      const t = setTimeout(() => { s.destroy(); reject(new Pop3Error(`Connecting to ${host}:${port} timed out`)); }, this.timeout);
      s.once(this.opts.secure ? 'secureConnect' : 'connect', () => { clearTimeout(t); resolve(s); });
      s.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    sock.removeAllListeners('error');
    this.attach(sock);
    await this.status(); // greeting
    if (this.opts.starttls && !this.opts.secure && (await this.offersStls())) {
      await this.cmd('STLS');
      this.sock.removeAllListeners('data');
      this.sock.removeAllListeners('close');
      const upgraded = tls.connect({ socket: this.sock, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: this.opts.rejectUnauthorized ?? false });
      await new Promise<void>((resolve, reject) => { upgraded.once('secureConnect', () => resolve()); upgraded.once('error', reject); });
      upgraded.removeAllListeners('error');
      this.attach(upgraded);
    }
  }

  /** Opportunistic STLS: only when CAPA lists it. */
  private async offersStls(): Promise<boolean> {
    try {
      await this.cmd('CAPA');
      return (await this.multi()).toString('latin1').split('\r\n').some((l) => l.trim().toUpperCase() === 'STLS');
    } catch { return false; }
  }

  async auth(user: string, pass: string): Promise<void> {
    try {
      await this.cmd(`USER ${user}`);
    } catch (e: any) {
      // server without USER/PASS: try AUTH PLAIN
      try {
        await this.cmd('AUTH PLAIN ' + Buffer.from(`\0${user}\0${pass}`).toString('base64'));
        return;
      } catch { throw new Pop3Error(`Sign-in rejected: ${e?.message ?? e}`); }
    }
    try { await this.cmd(`PASS ${pass}`); }
    catch (e: any) { throw new Pop3Error(`Sign-in rejected: ${e?.message ?? e}`); }
  }

  async stat(): Promise<{ count: number; size: number }> {
    const [c, s] = (await this.cmd('STAT')).split(/\s+/);
    return { count: Number(c) || 0, size: Number(s) || 0 };
  }

  /** message number → unique id */
  async uidl(): Promise<Map<number, string>> {
    await this.cmd('UIDL');
    const body = (await this.multi()).toString('latin1');
    const out = new Map<number, string>();
    for (const l of body.split('\r\n')) {
      const m = l.match(/^(\d+)\s+(\S+)/);
      if (m) out.set(Number(m[1]), m[2]);
    }
    return out;
  }

  async retr(n: number): Promise<Buffer> {
    await this.cmd(`RETR ${n}`);
    return this.multi();
  }

  async dele(n: number): Promise<void> { await this.cmd(`DELE ${n}`); }

  async quit(): Promise<void> {
    try { this.sock.write('QUIT\r\n'); await this.status(); } catch { /* ignore */ }
    this.sock.destroy();
  }
}
