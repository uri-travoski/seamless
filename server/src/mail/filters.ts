import type { ApiFilter, FilterCondition } from '@seamless/shared';
import { q } from '../db.ts';

export interface FilterableMessage {
  from: string;      // "Name <addr>" combined string
  to: string;
  cc: string;
  subject: string;
  body: string;
  hasAttachment: boolean;
  accountEmail: string;
}

function fieldValue(msg: FilterableMessage, field: FilterCondition['field']): string {
  switch (field) {
    case 'from': return msg.from;
    case 'to': return msg.to;
    case 'cc': return msg.cc;
    case 'subject': return msg.subject;
    case 'body': return msg.body;
    case 'has_attachment': return msg.hasAttachment ? 'yes' : 'no';
    case 'account': return msg.accountEmail;
  }
}

export function conditionMatches(msg: FilterableMessage, cond: FilterCondition): boolean {
  const value = fieldValue(msg, cond.field).toLowerCase();
  const target = cond.value.toLowerCase();
  switch (cond.op) {
    case 'contains': return value.includes(target);
    case 'not_contains': return !value.includes(target);
    case 'equals': return value === target;
    case 'starts_with': return value.startsWith(target);
    case 'ends_with': return value.endsWith(target);
  }
}

export function filterMatches(msg: FilterableMessage, filter: Pick<ApiFilter, 'match' | 'conditions'>): boolean {
  if (filter.conditions.length === 0) return false;
  const results = filter.conditions.map((c) => conditionMatches(msg, c));
  return filter.match === 'all' ? results.every(Boolean) : results.some(Boolean);
}

export async function loadFilters(userId: number): Promise<ApiFilter[]> {
  const rows = await q('SELECT * FROM filters WHERE user_id = ? ORDER BY sort, id', [userId]);
  return rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    enabled: !!r.enabled,
    sort: r.sort,
    match: r.match,
    conditions: JSON.parse(r.conditions),
    actions: JSON.parse(r.actions),
    stop: !!r.stop,
  }));
}

/**
 * Run enabled filters against a message; returns the combined action list
 * (execution — IMAP moves, label writes — happens in the ingest pipeline).
 */
export function evaluateFilters(msg: FilterableMessage, filters: ApiFilter[]) {
  const actions: ApiFilter['actions'] = [];
  for (const f of filters) {
    if (!f.enabled) continue;
    if (filterMatches(msg, f)) {
      actions.push(...f.actions);
      if (f.stop) break;
    }
  }
  return actions;
}
