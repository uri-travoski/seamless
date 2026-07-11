/** Deterministic rule matching — tier 1 of the classification cascade (DESIGN.md §3a). Pure functions. */

export interface RuleRow {
  id: number; user_id: number; enabled: boolean; ord: number;
  match_field: string;   // from|from_domain|to|delivered_to|subject_contains|body_contains|header|list_id|category
  match_value: string;
  exclude_contains: string;
  action: 'label' | 'ai';
  label_id: number | null;
  stop: boolean; note: string; source: string;
}

export interface MatchableMessage {
  fromAddr: string;
  toAddrs: string[];        // to + cc emails
  deliveredTo: string | null;
  subject: string;
  body: string;
  headers: Record<string, string>;  // lowercased header name -> value
}

/** Base local-part: strips +tags, lowercases ("Really.Basic+aws@Gmail.com" -> "really.basic@gmail.com"). */
export function baseAddress(addr: string): string {
  const lc = addr.trim().toLowerCase();
  const at = lc.lastIndexOf('@');
  if (at === -1) return lc;
  return lc.slice(0, at).split('+')[0] + lc.slice(at);
}

function domainMatches(addr: string, domain: string): boolean {
  const at = addr.lastIndexOf('@');
  if (at === -1) return false;
  const d = addr.slice(at + 1).toLowerCase();
  const target = domain.toLowerCase();
  return d === target || d.endsWith('.' + target);
}

export function ruleMatches(msg: MatchableMessage, rule: Pick<RuleRow, 'match_field' | 'match_value' | 'exclude_contains'>): boolean {
  const value = rule.match_value.trim().toLowerCase();
  if (!value) return false;
  const from = msg.fromAddr.toLowerCase();
  let hit = false;

  switch (rule.match_field) {
    case 'from':
      hit = from === value;
      break;
    case 'from_domain':
      hit = domainMatches(from, value);
      break;
    case 'to':
      hit = [...msg.toAddrs, ...(msg.deliveredTo ? [msg.deliveredTo] : [])]
        .some((a) => a.toLowerCase() === value);
      break;
    case 'delivered_to':
      // matches base local-part so plus-tags collapse (Forwarding Accounts semantics)
      hit = !!msg.deliveredTo && baseAddress(msg.deliveredTo) === baseAddress(value);
      break;
    case 'subject_contains':
      hit = msg.subject.toLowerCase().includes(value);
      break;
    case 'body_contains':
      hit = msg.body.toLowerCase().includes(value);
      break;
    case 'header': {
      // "list-id" (present) or "precedence:bulk" (value contains)
      const [name, ...rest] = value.split(':');
      const hv = msg.headers[name.trim()];
      hit = hv !== undefined && (rest.length === 0 || hv.toLowerCase().includes(rest.join(':').trim()));
      break;
    }
    case 'list_id':
      hit = msg.headers['list-id'] !== undefined &&
        (value === '*' || msg.headers['list-id'].toLowerCase().includes(value));
      break;
    case 'category':
      // 'promotions': bulk marketing heuristic — unsubscribe header present
      hit = value === 'promotions' && msg.headers['list-unsubscribe'] !== undefined;
      break;
    default:
      hit = false;
  }
  if (!hit) return false;

  if (rule.exclude_contains.trim()) {
    const haystack = (msg.subject + ' ' + msg.body).toLowerCase();
    const excluded = rule.exclude_contains.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (excluded.some((e) => haystack.includes(e))) return false;
  }
  return true;
}

/** Run rules in ord order; returns matched rules up to (and including) the first stop. */
export function evaluateRules(msg: MatchableMessage, rules: RuleRow[]): RuleRow[] {
  const matched: RuleRow[] = [];
  for (const r of [...rules].sort((a, b) => a.ord - b.ord || a.id - b.id)) {
    if (!r.enabled) continue;
    if (ruleMatches(msg, r)) {
      matched.push(r);
      if (r.stop) break;
    }
  }
  return matched;
}
