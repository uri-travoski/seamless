import { q, one, run, insertId } from '../db.ts';
import { freshAccessToken } from '../oauth.ts';
import { getTaskProvider } from '../ai/client.ts';
import { embedText, upsertVector } from '../classify/ai.ts';
import { plog } from '../classify/settings.ts';

/**
 * Learn-from-Gmail onboarding (DESIGN.md §7): read the account's existing labels and
 * labelled mail, infer deterministic rules for consistent senders, flag mixed senders
 * for the AI tier, and seed the embedding memory with the labelled history.
 */

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SAMPLE_PER_LABEL = 200;

interface GmailMessageMeta {
  from: string;         // bare address
  fromDomain: string;
  subject: string;
  snippet: string;
  label: string;        // gmail label name
}

export interface LearnProposal {
  kind: 'rule' | 'ai';
  matchField: 'from' | 'from_domain';
  matchValue: string;
  label: string | null;            // null for ai-routed
  evidence: number;                // messages backing this proposal
  split?: Record<string, number>;  // label distribution for mixed senders
}

async function gapi(token: string, path: string): Promise<any> {
  const res = await fetch(`${GMAIL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Gmail API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function bareAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

/** Fetch labelled message metadata (capped per label so onboarding stays quick). */
export async function fetchGmailSamples(token: string, onProgress: (msg: string) => Promise<void>): Promise<GmailMessageMeta[]> {
  const labelsRes = await gapi(token, '/labels');
  const userLabels = (labelsRes.labels ?? []).filter((l: any) => l.type === 'user');
  const out: GmailMessageMeta[] = [];

  for (const label of userLabels) {
    await onProgress(`reading label "${label.name}"`);
    let pageToken = '';
    let fetched = 0;
    while (fetched < SAMPLE_PER_LABEL) {
      const page = await gapi(token, `/messages?labelIds=${encodeURIComponent(label.id)}&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ''}`);
      const ids: string[] = (page.messages ?? []).map((m: any) => m.id);
      if (ids.length === 0) break;
      for (const id of ids) {
        if (fetched >= SAMPLE_PER_LABEL) break;
        try {
          const msg = await gapi(token, `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
          const headers = Object.fromEntries((msg.payload?.headers ?? []).map((h: any) => [h.name.toLowerCase(), h.value]));
          const from = bareAddress(headers.from ?? '');
          if (!from.includes('@')) continue;
          out.push({
            from,
            fromDomain: from.split('@')[1] ?? '',
            subject: headers.subject ?? '',
            snippet: msg.snippet ?? '',
            label: label.name,
          });
          fetched++;
        } catch { /* single message failure is fine */ }
      }
      pageToken = page.nextPageToken ?? '';
      if (!pageToken) break;
    }
  }
  return out;
}

/** Pure analysis: sender -> label consistency (DESIGN.md §7 step 2). */
export function analyseSamples(samples: GmailMessageMeta[]): LearnProposal[] {
  const bySender = new Map<string, Map<string, number>>();
  for (const s of samples) {
    if (!bySender.has(s.from)) bySender.set(s.from, new Map());
    const m = bySender.get(s.from)!;
    m.set(s.label, (m.get(s.label) ?? 0) + 1);
  }

  const proposals: LearnProposal[] = [];
  const senderVerdict = new Map<string, { label: string | null; total: number }>(); // null = mixed

  for (const [sender, counts] of bySender) {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    if (total < 3) continue; // not enough evidence either way
    const [topLabel, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topCount / total >= 0.9) {
      senderVerdict.set(sender, { label: topLabel, total });
    } else {
      senderVerdict.set(sender, { label: null, total });
      proposals.push({
        kind: 'ai', matchField: 'from', matchValue: sender, label: null, evidence: total,
        split: Object.fromEntries(counts),
      });
    }
  }

  // roll consistent senders up to domains where the whole domain agrees
  const byDomain = new Map<string, { label: string; senders: string[]; total: number } | null>();
  for (const [sender, v] of senderVerdict) {
    if (v.label === null) continue;
    const domain = sender.split('@')[1] ?? '';
    if (!domain) continue;
    const cur = byDomain.get(domain);
    if (cur === undefined) byDomain.set(domain, { label: v.label, senders: [sender], total: v.total });
    else if (cur && cur.label === v.label) { cur.senders.push(sender); cur.total += v.total; }
    else byDomain.set(domain, null); // disagreement -> no domain rule
  }

  const domainRuled = new Set<string>();
  for (const [domain, v] of byDomain) {
    if (v && (v.senders.length >= 2 || v.total >= 8)) {
      proposals.push({ kind: 'rule', matchField: 'from_domain', matchValue: domain, label: v.label, evidence: v.total });
      domainRuled.add(domain);
    }
  }
  for (const [sender, v] of senderVerdict) {
    if (v.label === null) continue;
    if (domainRuled.has(sender.split('@')[1] ?? '')) continue;
    proposals.push({ kind: 'rule', matchField: 'from', matchValue: sender, label: v.label, evidence: v.total });
  }

  return proposals.sort((a, b) => b.evidence - a.evidence);
}

/** Run the whole onboarding for an account; stores proposals on a gmail_imports row. */
export async function runGmailLearn(userId: number, accountId: number): Promise<number> {
  const acct = await one<any>("SELECT * FROM accounts WHERE id = ? AND user_id = ? AND kind = 'gmail'", [accountId, userId]);
  if (!acct) throw new Error('not a connected Gmail account');
  const importId = await insertId('INSERT INTO gmail_imports(user_id, account_id, status, started_at) VALUES (?,?,?,?)',
    [userId, accountId, 'running', Date.now()]);

  void (async () => {
    try {
      const token = await freshAccessToken(accountId);
      const samples = await fetchGmailSamples(token, (m) => plog(userId, 'import', `gmail learn: ${m}`));
      const proposals = analyseSamples(samples);

      // seed the embedding memory with the entire labelled sample (step 4 — "the real magic")
      let seeded = 0;
      const embedProvider = await getTaskProvider(userId, 'embed');
      if (embedProvider) {
        const labelIds = new Map<string, number>();
        for (const s of samples) {
          try {
            let lid = labelIds.get(s.label);
            if (lid === undefined) {
              const existing = await one<any>('SELECT id FROM labels WHERE user_id = ? AND lower(name) = lower(?)', [userId, s.label]);
              lid = existing?.id ?? await insertId('INSERT INTO labels(user_id, name, color) VALUES (?,?,?)', [userId, s.label, '#8a939c']);
              labelIds.set(s.label, lid!);
            }
            const vec = await embedText(embedProvider, `from: ${s.from}\nsubject: ${s.subject}\n${s.snippet}`.slice(0, 1500));
            // gmail seeds live outside local message ids: negative synthetic key
            await upsertVector(userId, -(importId * 1_000_000 + seeded + 1), lid!, vec);
            await run("UPDATE email_vectors SET source = 'gmail' WHERE message_id = ?", [-(importId * 1_000_000 + seeded + 1)]);
            seeded++;
          } catch { /* skip failed embeds */ }
        }
      }

      await run('UPDATE gmail_imports SET status = ?, proposals = ?, stats = ?, finished_at = ? WHERE id = ?',
        ['done', JSON.stringify(proposals), JSON.stringify({ samples: samples.length, proposals: proposals.length, seeded }), Date.now(), importId]);
      await plog(userId, 'import', `gmail learn finished: ${samples.length} messages analysed, ${proposals.length} proposals, ${seeded} embeddings seeded`);
    } catch (err: any) {
      await run('UPDATE gmail_imports SET status = ?, stats = ?, finished_at = ? WHERE id = ?',
        ['error', JSON.stringify({ error: err?.message ?? String(err) }), Date.now(), importId]);
      await plog(userId, 'import', `gmail learn failed: ${err?.message ?? err}`, { level: 'error' });
    }
  })();

  return importId;
}

/** Accept proposals: create labels + rules (source 'imported'). */
export async function acceptProposals(userId: number, importId: number, indexes: number[]): Promise<number> {
  const imp = await one<any>('SELECT * FROM gmail_imports WHERE id = ? AND user_id = ?', [importId, userId]);
  if (!imp) throw new Error('import not found');
  const proposals: LearnProposal[] = JSON.parse(imp.proposals);
  let created = 0;
  const maxOrd = (await one<{ m: number }>('SELECT COALESCE(MAX(ord),0) AS m FROM rules WHERE user_id = ?', [userId]))?.m ?? 0;

  for (const i of indexes) {
    const p = proposals[i];
    if (!p) continue;
    let labelId: number | null = null;
    if (p.kind === 'rule' && p.label) {
      const existing = await one<any>('SELECT id FROM labels WHERE user_id = ? AND lower(name) = lower(?)', [userId, p.label]);
      labelId = existing?.id ?? await insertId('INSERT INTO labels(user_id, name, color) VALUES (?,?,?)', [userId, p.label, '#8a939c']);
    }
    const dup = await one('SELECT 1 FROM rules WHERE user_id = ? AND match_field = ? AND lower(match_value) = lower(?)',
      [userId, p.matchField, p.matchValue]);
    if (dup) continue;
    await insertId(`
      INSERT INTO rules(user_id, enabled, ord, match_field, match_value, exclude_contains, action, label_id, stop, note, source, created_at)
      VALUES (?,true,?,?,?,'',?,?,true,?,'imported',?)
    `, [userId, maxOrd + 10 + created * 10, p.matchField, p.matchValue,
        p.kind === 'ai' ? 'ai' : 'label', p.kind === 'ai' ? null : labelId,
        p.kind === 'ai' ? `mixed sender from Gmail history: ${JSON.stringify(p.split)}` : `learned from Gmail (${p.evidence} messages)`, Date.now()]);
    created++;
  }
  return created;
}
