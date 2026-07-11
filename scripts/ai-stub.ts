/* Tiny OpenAI-compatible stub for local dev/demo: npm run ai-stub (port 4909) */
import http from 'node:http';
import crypto from 'node:crypto';

/** Deterministic fake embedding: same text -> same vector, similar text -> similar vector. */
function fakeEmbedding(text: string, dim = 256): number[] {
  const vec = new Array(dim).fill(0);
  const words = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const w of words) {
    const h = crypto.createHash('md5').update(w).digest();
    for (let i = 0; i < 8; i++) vec[h[i] % dim] += (h[(i + 8) % 16] / 128) - 1;
  }
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map((x) => x / norm);
}

function classifyVerdict(user: string): string {
  const text = user.toLowerCase();
  const real = /itemised|invoice #|receipt total|attachment "|tax invoice|order total|qty/i.test(user);
  const action = /suspend|action required|payment due|deadline|expire|verify your|overdue/.test(text);
  const marketing = /unsubscribe|deal|% off|sale|newsletter|digest/.test(text);
  const paymentNotice = /payment successful|was processed|charged|direct debit/.test(text) && !real;
  let label: string | null = null;
  let category = 'other';
  let retention = 'keep';
  if (real) { label = 'Receipts'; category = 'receipt'; retention = 'keep'; }
  else if (action) { category = 'notification'; retention = 'keep'; }
  else if (paymentNotice) { label = 'To Delete'; category = 'notification'; retention = 'delete'; }
  else if (marketing) { label = 'Sale'; category = 'marketing'; retention = 'delete'; }
  const warranty = user.match(/(\d+)[- ]year warranty/i);
  return JSON.stringify({
    category,
    label,
    is_real_document: real,
    requires_action: action,
    worth_keeping: real || action,
    retention,
    warranty_months: warranty ? Number(warranty[1]) * 12 : null,
    confidence: 0.92,
    reason: real ? 'itemised document present' : action ? 'has consequences if ignored' : paymentNotice ? 'bare payment notice' : marketing ? 'marketing' : 'no strong signal',
  });
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method === 'POST' && req.url?.endsWith('/embeddings')) {
      try {
        const data = JSON.parse(body);
        const inputs: string[] = Array.isArray(data.input) ? data.input : [data.input];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: inputs.map((t, i) => ({ index: i, embedding: fakeEmbedding(String(t)) })) }));
      } catch {
        res.writeHead(400).end();
      }
      return;
    }
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let content = 'ok';
    try {
      const data = JSON.parse(body);
      const system: string = data.messages.find((m: any) => m.role === 'system')?.content ?? '';
      const user: string = data.messages.find((m: any) => m.role === 'user')?.content ?? '';
      if (system.includes('orthogonal fields')) {
        content = classifyVerdict(user);
      } else if (system.includes('structured directives')) {
        const instr = (user.match(/Instruction: ([\s\S]*)$/)?.[1] ?? user).toLowerCase();
        const labels = [...system.matchAll(/- "([^"]+)"/g)].map((m) => m[1]);
        let label: string | null = null;
        // an explicit "label these X" instruction wins over keyword guesses
        const explicit = instr.match(/label(?:\s+(?:it|them|these|as))*\s+(?:as\s+)?["']?([a-z][a-z]+)/);
        if (explicit) label = explicit[1].trim().replace(/\b\w/g, (c) => c.toUpperCase());
        if (!label) label = labels.find((l) => instr.includes(l.toLowerCase())) ?? null;
        if (!label) {
          if (/warrant/.test(instr)) label = 'Warranties';
          else if (/receipt|invoice|purchase|order/.test(instr)) label = 'Receipts';
          else if (/newsletter|digest|subscrib/.test(instr)) label = 'Newsletters';
          else if (/travel|flight|hotel|booking|trip/.test(instr)) label = 'Travel';
          else if (/bank|statement|financ/.test(instr)) label = 'Banking';
        }
        const days = instr.match(/(\d+)\s*day/);
        const yrs = instr.match(/(\d+)\s*year/);
        const retention_days = days ? Number(days[1]) : yrs ? Number(yrs[1]) * 365 : null;
        const auto_read = /mark(?:ed)?(?: it| them| these)? (?:as )?read|auto.?read|read on arrival/.test(instr);
        const delete_if_unread = /if i (?:don'?t|never|do not) read|unless i read/.test(instr);
        const summary = (user.match(/Instruction: (.+)/)?.[1] ?? '').slice(0, 160) || 'Handle matching mail per your instruction';
        content = JSON.stringify({ summary, label, retention_days, auto_read, delete_if_unread });
      } else if (system.includes('categorize')) {
        const labels = [...system.matchAll(/- "([^"]+)"/g)].map((m) => m[1]);
        const text = user.toLowerCase();
        const pick =
          labels.find((l) => text.includes(l.toLowerCase())) ??
          (/invoice|billing|payment|receipt/.test(text) ? labels.find((l) => /finance|billing/i.test(l)) : undefined) ??
          (/deal|offer|sale|newsletter|digest/.test(text) ? labels.find((l) => /news|promo|shopping/i.test(l)) : undefined) ??
          (/support|reset|bug|feature/.test(text) ? labels.find((l) => /support|work/i.test(l)) : undefined);
        content = JSON.stringify({ label: pick ?? null });
      } else if (system.includes('Summarize')) {
        content = '- Thread about: ' + (user.match(/Subject: (.*)/)?.[1] ?? 'a conversation') + '\n- Participants exchanged updates and agreed on next steps\n- Open item: confirm the remaining details';
      } else if (system.includes('Draft a reply')) {
        content = 'Thanks for your message.\n\nI looked into this and will get back to you with the details by tomorrow. Let me know if anything is urgent in the meantime.';
      }
    } catch { /* default */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'stub', choices: [{ message: { role: 'assistant', content } }] }));
  });
});

server.listen(4909, () => console.log('AI stub on http://localhost:4909/v1'));
