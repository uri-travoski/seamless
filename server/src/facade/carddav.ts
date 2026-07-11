import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { one, run } from '../db.ts';
import { facadeLogin } from './auth.ts';
import { listContacts, contactToVcf, contactEtag, importVcf, type ContactRow } from '../contacts.ts';

/**
 * Minimal CardDAV server under /dav so phones sync the addressbook natively
 * (DAVx5, iOS/macOS Contacts). One addressbook per user; Basic auth = app passwords.
 * Read/write: PUT creates or updates a card, DELETE hides the contact.
 */

const xml = (s: string) => `<?xml version="1.0" encoding="utf-8"?>\n${s}`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function davAuth(req: FastifyRequest): Promise<{ userId: number } | null> {
  const h = req.headers.authorization;
  if (!h?.startsWith('Basic ')) return null;
  const [user, ...rest] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  const auth = await facadeLogin(user, rest.join(':'), 'carddav');
  return auth ? { userId: auth.userId } : null;
}

function needAuth(reply: FastifyReply): void {
  reply.header('WWW-Authenticate', 'Basic realm="Seamless CardDAV"').code(401).send('auth required');
}

async function ctag(userId: number): Promise<string> {
  const row = await one<{ m: number | null; c: number }>('SELECT MAX(updated_at) AS m, COUNT(*) AS c FROM contacts WHERE user_id = ?', [userId]);
  return `${row?.c ?? 0}-${row?.m ?? 0}`;
}

function cardResponse(base: string, c: ContactRow, withData: boolean): string {
  return `<d:response>
  <d:href>${base}${c.id}.vcf</d:href>
  <d:propstat><d:prop>
    <d:getetag>"${contactEtag(c)}"</d:getetag>
    <d:getcontenttype>text/vcard; charset=utf-8</d:getcontenttype>
    ${withData ? `<card:address-data>${esc(contactToVcf(c))}</card:address-data>` : ''}
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
</d:response>`;
}

export function registerCardDav(app: FastifyInstance): void {
  // WebDAV verbs aren't registered by default
  for (const m of ['PROPFIND', 'REPORT']) {
    try { (app as any).addHttpMethod(m, { hasBody: true }); } catch { /* already added */ }
  }
  app.addContentTypeParser(['application/xml', 'text/xml', 'text/vcard'], { parseAs: 'string' }, (_req, body, done) => done(null, body));
  // DAV clients send bodies with odd or missing content types — accept anything as text
  try {
    app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  } catch { /* a wildcard parser already exists */ }

  const route = (method: string, url: string, handler: (req: FastifyRequest, reply: FastifyReply, userId: number) => Promise<any>) => {
    app.route({
      method: method as any,
      url,
      handler: async (req, reply) => {
        const auth = await davAuth(req);
        if (!auth) return needAuth(reply);
        return handler(req, reply, auth.userId);
      },
    });
  };

  for (const url of ['/dav', '/dav/', '/dav/*']) {
    app.route({
      method: 'OPTIONS' as any, url,
      handler: async (_req, reply) => {
        reply.header('DAV', '1, 3, addressbook').header('Allow', 'OPTIONS, PROPFIND, REPORT, GET, PUT, DELETE').send();
      },
    });
  }

  const propfind = async (req: FastifyRequest, reply: FastifyReply, userId: number) => {
    const depth = String(req.headers.depth ?? '0');
    const path = req.url.split('?')[0];
    const home = `/dav/addressbooks/${userId}/`;
    const book = `${home}default/`;
    const responses: string[] = [];

    const principal = `<d:response><d:href>/dav/</d:href><d:propstat><d:prop>
      <d:current-user-principal><d:href>/dav/principals/${userId}/</d:href></d:current-user-principal>
      <d:resourcetype><d:collection/></d:resourcetype>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

    const principalProps = `<d:response><d:href>/dav/principals/${userId}/</d:href><d:propstat><d:prop>
      <card:addressbook-home-set><d:href>${home}</d:href></card:addressbook-home-set>
      <d:resourcetype><d:principal/></d:resourcetype>
      <d:displayname>Seamless</d:displayname>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

    const bookProps = `<d:response><d:href>${book}</d:href><d:propstat><d:prop>
      <d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>
      <d:displayname>Seamless Contacts</d:displayname>
      <cs:getctag>${await ctag(userId)}</cs:getctag>
      <d:sync-token>${await ctag(userId)}</d:sync-token>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

    if (path.startsWith('/dav/principals/')) responses.push(principalProps);
    else if (path === book || path === book.slice(0, -1)) {
      responses.push(bookProps);
      if (depth !== '0') {
        for (const c of await listContacts(userId)) responses.push(cardResponse(book, c, false));
      }
    } else if (path === home || path === home.slice(0, -1)) {
      responses.push(bookProps);
    } else {
      responses.push(principal, principalProps, bookProps);
    }

    reply.code(207).header('Content-Type', 'application/xml; charset=utf-8')
      .send(xml(`<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/">${responses.join('\n')}</d:multistatus>`));
  };
  route('PROPFIND', '/dav', propfind);
  route('PROPFIND', '/dav/*', propfind);

  route('REPORT', '/dav/*', async (req, reply, userId) => {
    const body = String(req.body ?? '');
    const book = `/dav/addressbooks/${userId}/default/`;
    const contacts = await listContacts(userId);
    let picked = contacts;
    if (/addressbook-multiget/i.test(body)) {
      const hrefs = [...body.matchAll(/<d?:?href[^>]*>([^<]+)<\/[^>]*href>/gi)].map((m) => m[1]);
      const ids = new Set(hrefs.map((h) => Number(h.match(/(\d+)\.vcf/)?.[1] ?? 0)));
      picked = contacts.filter((c) => ids.has(c.id));
    }
    const responses = picked.map((c) => cardResponse(book, c, true));
    reply.code(207).header('Content-Type', 'application/xml; charset=utf-8')
      .send(xml(`<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">${responses.join('\n')}</d:multistatus>`));
  });

  route('GET', '/dav/addressbooks/:uid/default/:file', async (req, reply, userId) => {
    const id = Number(String((req.params as any).file).replace(/\.vcf$/, ''));
    const c = (await listContacts(userId, true)).find((x) => x.id === id);
    if (!c) return reply.code(404).send('not found');
    reply.header('Content-Type', 'text/vcard; charset=utf-8').header('ETag', `"${contactEtag(c)}"`).send(contactToVcf(c));
  });

  route('PUT', '/dav/addressbooks/:uid/default/:file', async (req, reply, userId) => {
    const created = await importVcf(userId, String(req.body ?? ''));
    reply.code(created > 0 ? 201 : 204).send();
  });

  route('DELETE', '/dav/addressbooks/:uid/default/:file', async (req, reply, userId) => {
    const id = Number(String((req.params as any).file).replace(/\.vcf$/, ''));
    await run('UPDATE contacts SET hidden = true, updated_at = ? WHERE id = ? AND user_id = ?', [Date.now(), id, userId]);
    reply.code(204).send();
  });
}
