import type { ApiEmail, ApiEmailBody, ApiMailbox, ApiIdentity, ComposePayload, EmailQueryFilter, EmailQueryResponse, TrackingInfo } from '@seamless/shared';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'same-origin',
    ...init,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error ?? msg; } catch { /* keep statusText */ }
    if (res.status === 401) window.dispatchEvent(new Event('md-unauthorized'));
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(url: string) => req<T>(url),
  post: <T>(url: string, body?: unknown) => req<T>(url, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined }),
  put: <T>(url: string, body?: unknown) => req<T>(url, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T>(url: string) => req<T>(url, { method: 'DELETE' }),
};

type MethodCall = [string, any, string];

export async function jmap(methodCalls: MethodCall[]): Promise<Record<string, any>> {
  const res = await req<{ methodResponses: MethodCall[] }>('/jmap/api', {
    method: 'POST',
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls }),
  });
  const byTag: Record<string, any> = {};
  for (const [name, result, tag] of res.methodResponses) {
    if (name === 'error') throw new ApiError(500, result.description ?? result.type ?? 'JMAP error');
    byTag[tag] = result;
  }
  return byTag;
}

export async function fetchMailboxes(scope?: string): Promise<ApiMailbox[]> {
  const r = await jmap([['Mailbox/get', scope && scope !== 'unified' ? { scope } : {}, 'a']]);
  return r.a.list;
}

export async function queryEmailPage(filter: EmailQueryFilter, position: number, limit = 120): Promise<{ query: EmailQueryResponse; emails: ApiEmail[] }> {
  const r = await jmap([
    ['Email/query', { filter, position, limit }, 'q'],
    ['Email/get', { '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' } }, 'g'],
  ]);
  // server subset doesn't do back-references; fall back to explicit second call
  if (!r.g || !Array.isArray(r.g.list) || (r.q.ids.length > 0 && r.g.list.length === 0)) {
    const r2 = await jmap([['Email/get', { ids: r.q.ids }, 'g']]);
    return { query: r.q, emails: r2.g.list };
  }
  return { query: r.q, emails: r.g.list };
}

export async function getEmailsByIds(ids: string[]): Promise<ApiEmail[]> {
  if (ids.length === 0) return [];
  const r = await jmap([['Email/get', { ids }, 'g']]);
  return r.g.list;
}

export async function getThread(threadId: string): Promise<string[]> {
  const r = await jmap([['Thread/get', { ids: [threadId] }, 't']]);
  return r.t.list[0]?.emailIds ?? [];
}

export async function emailSet(update: Record<string, Record<string, unknown>>, destroy: string[] = []): Promise<void> {
  await jmap([['Email/set', { update, destroy }, 's']]);
}

export const fetchBody = (id: string, remote: boolean) =>
  api.get<ApiEmailBody>(`/api/message/${id}/body${remote ? '?remote=1' : ''}`);
export const fetchTracking = (id: string) => api.get<TrackingInfo>(`/api/message/${id}/tracking`);

export const saveNote = (emailId: string, body: string) => api.put<{ ok: boolean }>(`/api/message/${emailId}/note`, { body });
export const matchIdentity = (emailId: string) => api.post<ApiIdentity>('/api/identity/match', { emailId });
export const fetchIdentities = () => api.get<ApiIdentity[]>('/api/identities');
export const sendMail = (payload: ComposePayload) => api.post<{ ok: boolean; queued: boolean; jobId?: number; releaseAt?: number }>('/api/send', payload);
export const undoSendApi = (jobId: number) => api.post<{ payload: ComposePayload }>('/api/send/undo', { jobId });
export const saveDraftApi = (payload: ComposePayload) => api.post<{ ok: boolean }>('/api/draft', payload);
export const scheduleMail = (payload: ComposePayload, sendAt: number) =>
  api.post<{ ok: boolean; id: number; sendAt: number }>('/api/schedule', { ...payload, sendAt });

export async function uploadFile(file: File): Promise<{ id: string; filename: string; size: number }> {
  const fd = new FormData();
  fd.append('file', file);
  return req('/api/upload', { method: 'POST', body: fd });
}
