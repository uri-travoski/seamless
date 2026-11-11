import type { ApiIdentity } from '@seamless/shared';
import { q, currentState } from '../db.ts';
import { listMailboxes, queryEmails, getEmails, getThreadEmailIds, setKeywords, setLabels, moveEmail, destroyEmail } from '../mail/store.ts';
import { sendEmail } from '../mail/send.ts';
import { config } from '../config.ts';

export async function jmapSession() {
  return {
    capabilities: {
      'urn:ietf:params:jmap:core': { maxSizeUpload: 50_000_000, maxCallsInRequest: 32 },
      'urn:ietf:params:jmap:mail': {},
      'urn:ietf:params:jmap:submission': {},
    },
    accounts: {
      unified: {
        name: 'Unified',
        isPersonal: true,
        accountCapabilities: { 'urn:ietf:params:jmap:mail': {} },
      },
    },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'unified' },
    apiUrl: `${config.publicUrl}/jmap/api`,
    state: await currentState(),
  };
}

export async function listIdentities(userId: number): Promise<ApiIdentity[]> {
  const accounts = await q<{ id: number; name: string; email: string; aliases: string }>(
    'SELECT id, name, email, aliases FROM accounts WHERE user_id = ? AND enabled = true ORDER BY id', [userId]);
  const out: ApiIdentity[] = [];
  for (const a of accounts) {
    out.push({ accountId: a.id, email: a.email, name: a.name, isAlias: false });
    for (const alias of JSON.parse(a.aliases) as string[]) {
      out.push({ accountId: a.id, email: alias, name: a.name, isAlias: true });
    }
    for (const d of await q<{ address: string }>("SELECT address FROM disposable_addresses WHERE account_id = ? AND status = 'active' ORDER BY id", [a.id])) {
      out.push({ accountId: a.id, email: d.address, name: a.name, isAlias: true });
    }
  }
  return out;
}

type MethodCall = [string, any, string];

/** JMAP patch semantics: {"keywords/$seen": true} and full-object sets. */
async function applyEmailUpdate(userId: number, id: string, patch: Record<string, any>): Promise<void> {
  const keywordPatch: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'keywords' && value && typeof value === 'object') {
      const current = (await getEmails(userId, [id]))[0]?.keywords ?? {};
      for (const kw of new Set([...Object.keys(current), ...Object.keys(value)])) {
        keywordPatch[kw] = !!value[kw];
      }
    } else if (key.startsWith('keywords/')) {
      keywordPatch[key.slice('keywords/'.length)] = value === true;
    } else if (key === 'mailboxIds' && value && typeof value === 'object') {
      const target = Object.keys(value).find((k) => value[k] === true);
      if (target) await moveEmail(userId, id, target);
    } else if (key.startsWith('mailboxIds/') && value === true) {
      await moveEmail(userId, id, key.slice('mailboxIds/'.length));
    } else if (key === 'labelIds' && Array.isArray(value)) {
      await setLabels(userId, id, value.map(Number));
    }
  }
  if (Object.keys(keywordPatch).length > 0) await setKeywords(userId, id, keywordPatch);
}

export async function handleMethodCall(userId: number, call: MethodCall): Promise<MethodCall[]> {
  const [name, args, tag] = call;
  try {
    switch (name) {
      case 'Mailbox/get':
        return [[name, { accountId: 'unified', state: await currentState(), list: await listMailboxes(userId, args?.scope), notFound: [] }, tag]];

      case 'Email/query': {
        const res = await queryEmails(userId, {
          filter: args.filter ?? {},
          position: args.position ?? 0,
          limit: Math.min(args.limit ?? 120, 500),
        });
        return [[name, { accountId: 'unified', ...res, canCalculateChanges: false }, tag]];
      }

      case 'Email/get': {
        const ids: string[] = args.ids ?? [];
        const list = await getEmails(userId, ids);
        const found = new Set(list.map((e) => e.id));
        return [[name, { accountId: 'unified', state: await currentState(), list, notFound: ids.filter((i) => !found.has(i)) }, tag]];
      }

      case 'Thread/get': {
        const ids: string[] = args.ids ?? [];
        const list: { id: string; emailIds: string[] }[] = [];
        for (const id of ids) list.push({ id, emailIds: await getThreadEmailIds(userId, id) });
        return [[name, { accountId: 'unified', state: await currentState(), list, notFound: [] }, tag]];
      }

      case 'Email/set': {
        const updated: Record<string, null> = {};
        const notUpdated: Record<string, { type: string }> = {};
        for (const [id, patch] of Object.entries(args.update ?? {})) {
          try { await applyEmailUpdate(userId, id, patch as any); updated[id] = null; }
          catch { notUpdated[id] = { type: 'serverFail' }; }
        }
        const destroyed: string[] = [];
        for (const id of (args.destroy ?? []) as string[]) {
          await destroyEmail(userId, id);
          destroyed.push(id);
        }
        return [[name, { accountId: 'unified', newState: await currentState(), updated, notUpdated, destroyed }, tag]];
      }

      case 'Identity/get':
        return [[name, { accountId: 'unified', state: await currentState(), list: await listIdentities(userId), notFound: [] }, tag]];

      case 'EmailSubmission/set': {
        const created: Record<string, any> = {};
        const notCreated: Record<string, { type: string; description: string }> = {};
        for (const [cid, spec] of Object.entries((args.create ?? {}) as Record<string, any>)) {
          try {
            const result = await sendEmail(userId, spec.compose);
            created[cid] = { id: cid, trackingToken: result.trackingToken };
          } catch (err: any) {
            notCreated[cid] = { type: 'serverFail', description: err?.message ?? 'send failed' };
          }
        }
        return [[name, { accountId: 'unified', newState: await currentState(), created, notCreated }, tag]];
      }

      default:
        return [['error', { type: 'unknownMethod' }, tag]];
    }
  } catch (err: any) {
    return [['error', { type: 'serverFail', description: err?.message ?? String(err) }, tag]];
  }
}

/** Resolve JMAP back-references: {"#ids": {resultOf, name, path}} against prior responses. */
function resolveBackrefs(args: any, responses: MethodCall[]): any {
  if (!args || typeof args !== 'object') return args;
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key.startsWith('#') && value && typeof value === 'object') {
      const ref = value as { resultOf: string; name: string; path: string };
      const source = responses.find(([name, , tag]) => tag === ref.resultOf && name === ref.name);
      if (!source) throw new Error(`unresolved back-reference ${key}`);
      let cur: any = source[1];
      for (const seg of ref.path.split('/').filter(Boolean)) cur = cur?.[seg];
      out[key.slice(1)] = cur;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export async function handleJmapRequest(userId: number, body: { methodCalls: MethodCall[] }): Promise<{ methodResponses: MethodCall[]; sessionState: string }> {
  const methodResponses: MethodCall[] = [];
  for (const call of body.methodCalls ?? []) {
    try {
      const resolved: MethodCall = [call[0], resolveBackrefs(call[1], methodResponses), call[2]];
      methodResponses.push(...(await handleMethodCall(userId, resolved)));
    } catch (err: any) {
      methodResponses.push(['error', { type: 'invalidResultReference', description: err?.message }, call[2]]);
    }
  }
  return { methodResponses, sessionState: await currentState() };
}
