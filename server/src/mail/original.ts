import type { ParsedMail } from 'mailparser';
import { getBlob } from '../s3.ts';
import { getMsgRow } from './store.ts';
import { getParsed } from './body.ts';

import { parseAuth, type AuthInfo, type AuthResult } from './auth.ts';
export { parseAuth };

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function badgeColor(result: string): string {
  const r = result.toUpperCase();
  if (r === 'PASS') return '#188038';
  if (r === 'FAIL' || r === 'PERMERROR') return '#d93025';
  if (r === 'SOFTFAIL' || r === 'NEUTRAL' || r === 'TEMPERROR') return '#e37400';
  return '#5f6368';
}

function authRow(label: string, a: AuthResult | null): string {
  if (!a) return `<tr><th>${label}:</th><td><span class="muted">Not present</span></td></tr>`;
  return `<tr><th>${label}:</th><td><b style="color:${badgeColor(a.result)}">'${esc(a.result)}'</b> ${esc(a.detail)}</td></tr>`;
}

function addr(list: ParsedMail['from']): string {
  return esc(list?.text ?? '');
}

export async function buildOriginalPage(userId: number, emailId: string): Promise<string | null> {
  const row = await getMsgRow(userId, emailId);
  if (!row || !row.s3_key) return null;
  const parsed = await getParsed(row.id);
  if (!parsed) return null;
  const raw = (await getBlob(row.s3_key)).toString('utf8');
  const auth = parseAuth(parsed);

  const rows = [
    `<tr><th>Message ID:</th><td><span class="mono">${esc(parsed.messageId ?? '')}</span></td></tr>`,
    `<tr><th>Created&nbsp;on:</th><td>${esc(parsed.date ? parsed.date.toUTCString() : '')}</td></tr>`,
    `<tr><th>From:</th><td>${addr(parsed.from)}</td></tr>`,
    `<tr><th>To:</th><td>${esc((Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(', ') : parsed.to?.text) ?? '')}</td></tr>`,
    `<tr><th>Subject:</th><td>${esc(parsed.subject ?? '')}</td></tr>`,
    authRow('SPF', auth.spf),
    authRow('DKIM', auth.dkim),
    authRow('DMARC', auth.dmarc),
  ].join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Original message</title>
<style>
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #202124; background: #fff; }
  .wrap { max-width: 1000px; margin: 0 auto; padding: 20px 24px; }
  h1 { font-size: 18px; font-weight: 500; margin: 4px 0 18px; }
  table.meta { width: 100%; border-collapse: collapse; border: 1px solid #e0e0e0; font-size: 13px; margin-bottom: 14px; }
  table.meta th, table.meta td { text-align: left; vertical-align: top; padding: 9px 14px; border-bottom: 1px solid #eee; }
  table.meta th { width: 150px; font-weight: 500; color: #5f6368; background: #f8f9fa; white-space: nowrap; }
  table.meta tr:last-child th, table.meta tr:last-child td { border-bottom: none; }
  .mono, .muted { color: #1a73e8; word-break: break-all; }
  .muted { color: #80868b; }
  .actions { display: flex; align-items: center; gap: 16px; margin: 4px 0 20px; }
  .actions a { color: #1a73e8; text-decoration: none; font-size: 13px; }
  .actions a:hover { text-decoration: underline; }
  .actions .spacer { flex: 1; }
  button.copy { background: #1a73e8; color: #fff; border: none; border-radius: 4px; padding: 8px 16px; font-size: 13px; cursor: pointer; }
  button.copy:hover { background: #1765cc; }
  .raw-wrap { background: #f1f3f4; border-top: 1px solid #e0e0e0; }
  pre.raw { max-width: 1000px; margin: 0 auto; padding: 20px 24px; white-space: pre-wrap; word-break: break-word; font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 12px; line-height: 1.5; color: #3c4043; }
</style></head>
<body>
  <div class="wrap">
    <h1>Original message</h1>
    <table class="meta"><tbody>${rows}</tbody></table>
    <div class="actions">
      <a href="/api/raw/${esc(emailId)}" download>Download original</a>
      <span class="spacer"></span>
      <button class="copy" onclick="navigator.clipboard.writeText(document.getElementById('raw').textContent).then(()=>{this.textContent='Copied';setTimeout(()=>this.textContent='Copy to clipboard',1500)})">Copy to clipboard</button>
    </div>
  </div>
  <div class="raw-wrap"><pre class="raw" id="raw">${esc(raw)}</pre></div>
</body></html>`;
}
