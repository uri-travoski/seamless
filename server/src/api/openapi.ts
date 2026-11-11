/** Hand-written OpenAPI 3.1 document for REST v1 (T5 F-37), served at GET /api/v1/openapi.json. A test checks every path exists. */
const sec = (scope: string) => [{ bearer: [scope] }];
const err = { '401': { description: 'Missing, revoked or expired token' }, '403': { description: 'Token lacks the scope (or your role on a shared mailbox does not allow it)' }, '429': { description: '600 requests per minute per token exceeded' } };
const ok = (description = 'OK') => ({ '200': { description }, ...err });
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', example: 'm123' } };

export const openapi = {
  openapi: '3.1.0',
  info: { title: 'Seamless REST API', version: 'v1', description: 'Personal API tokens (Settings → Integrations → API tokens). Send `Authorization: Bearer sk_sl_…`. Cookie sessions are not accepted.' },
  servers: [{ url: '/api/v1' }],
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'API token. Scopes: mail:read, labels:write, mail:send, events:subscribe, contacts:read' } } },
  paths: {
    '/openapi.json': { get: { summary: 'This document (public)', responses: { '200': { description: 'OpenAPI 3.1 JSON' } } } },
    '/messages': { get: {
      summary: 'Search / list messages', security: sec('mail:read'),
      parameters: [
        { name: 'query', in: 'query', schema: { type: 'string' }, description: 'Search language, e.g. `from:bob is:unread`' },
        { name: 'scope', in: 'query', schema: { type: 'string', default: 'unified' }, description: 'unified | category:<id> | account:<id>' },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
        { name: 'cursor', in: 'query', schema: { type: 'string' }, description: '`nextCursor` from the previous page' },
      ], responses: ok('{ items, total, nextCursor }') } },
    '/messages/{id}': { get: { summary: 'One message with text/html body and attachments list', security: sec('mail:read'), parameters: [idParam], responses: { ...ok(), '404': { description: 'Not found' } } } },
    '/messages/{id}/raw': { get: { summary: 'Original RFC 822 source', security: sec('mail:read'), parameters: [idParam], responses: { ...ok('message/rfc822'), '404': { description: 'Not found' } } } },
    '/messages/{id}/labels': { post: {
      summary: 'Add and/or remove labels', security: sec('labels:write'), parameters: [idParam],
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { add: { type: 'array', items: { type: 'integer' } }, remove: { type: 'array', items: { type: 'integer' } } } } } } },
      responses: ok() } },
    '/messages/{id}/archive': { post: { summary: 'Move to Archive', security: sec('labels:write'), parameters: [idParam], responses: ok() } },
    '/send': { post: {
      summary: 'Send a message now (no undo delay) through the identity and its transport', security: sec('mail:send'),
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['identityId', 'to', 'subject'], properties: {
        identityId: { type: 'integer' }, to: { type: 'array', items: { type: 'string' } }, cc: { type: 'array', items: { type: 'string' } }, bcc: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' }, html: { type: 'string' }, text: { type: 'string' } } } } } },
      responses: { ...ok('{ ok: true }'), '400': { description: 'Invalid request' }, '502': { description: 'Transport failed' } } } },
    '/events': { get: {
      summary: 'Long-poll the event feed, ordered by id', security: sec('events:subscribe'),
      parameters: [
        { name: 'since', in: 'query', schema: { type: 'integer', default: 0 }, description: 'Return events with id greater than this' },
        { name: 'wait', in: 'query', schema: { type: 'integer', default: 0, maximum: 30 }, description: 'Seconds to hold the request open when nothing is new' },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 100, maximum: 500 } },
      ], responses: ok('{ items: [{ id, type, subject, payload, createdAt }], cursor }') } },
    '/subscriptions': { post: {
      summary: 'Create a webhook subscription (signing secret shown once)', security: sec('events:subscribe'),
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['url', 'eventTypes'], properties: {
        name: { type: 'string' }, url: { type: 'string' }, eventTypes: { type: 'array', items: { type: 'string' } }, filterQuery: { type: 'string' }, include: { type: 'string', enum: ['metadata', 'body', 'attachments', 'raw'] } } } } } },
      responses: { ...ok(), '400': { description: 'Invalid request' } } } },
    '/subscriptions/{id}': { delete: { summary: 'Delete a webhook subscription', security: sec('events:subscribe'), parameters: [idParam], responses: { ...ok(), '404': { description: 'Not found' } } } },
    '/contacts': { get: { summary: 'List contacts', security: sec('contacts:read'), responses: ok() } },
  },
} as const;

/** [method, path] pairs for the route-existence test (OpenAPI `{id}` → Fastify `:id`). */
export function openapiRoutes(): [string, string][] {
  const out: [string, string][] = [];
  for (const [p, ops] of Object.entries(openapi.paths)) for (const m of Object.keys(ops)) out.push([m.toUpperCase(), '/api/v1' + p.replace(/\{(\w+)\}/g, ':$1')]);
  return out;
}
