/* Tiny OpenAI-compatible stub for local dev/demo: npm run ai-stub (port 4909) */
import http from 'node:http';

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let content = 'ok';
    try {
      const data = JSON.parse(body);
      const system: string = data.messages.find((m: any) => m.role === 'system')?.content ?? '';
      const user: string = data.messages.find((m: any) => m.role === 'user')?.content ?? '';
      if (system.includes('categorize')) {
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
