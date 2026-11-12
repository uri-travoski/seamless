#!/usr/bin/env node
// Tiny local receiver for watching Seamless webhook / connector deliveries.
//   node scripts/echo-server.mjs [port]        (default 4999)
// Point a webhook at http://127.0.0.1:4999/hook (add 127.0.0.1 to Settings → Integrations → allow-list first).
import http from 'node:http';
import crypto from 'node:crypto';
const port = Number(process.argv[2] ?? process.env.PORT ?? 4999);
const secret = process.env.WEBHOOK_SECRET;   // optional: verify the X-Seamless-Signature header
http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    console.log(`\n${new Date().toISOString()} ${req.method} ${req.url} (${body.length} bytes)`);
    for (const [k, v] of Object.entries(req.headers)) if (/^(x-|content-type|authorization)/i.test(k)) console.log(`  ${k}: ${k.toLowerCase() === 'authorization' ? '[hidden]' : v}`);
    const sig = String(req.headers['x-seamless-signature'] ?? '');
    const ts = String(req.headers['x-seamless-timestamp'] ?? '');
    if (secret && sig) console.log('  signature', sig === `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${body.toString('utf8')}`).digest('hex')}` ? 'valid' : 'INVALID');
    console.log('  ' + body.toString('utf8').slice(0, 1500).replace(/\n/g, '\n  '));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
}).listen(port, '127.0.0.1', () => console.log(`echo server listening on http://127.0.0.1:${port}`));
