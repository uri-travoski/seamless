/* Bulk demo mail to test pagination (300 messages into the inbox).
   Run: node --import tsx scripts/seed-bulk.ts */
import nodemailer from 'nodemailer';

const smtp = nodemailer.createTransport({ host: 'localhost', port: 3026, secure: false, tls: { rejectUnauthorized: false } });

const N = 300;
const senders = ['newsletter@acme.test', 'noreply@shoply.test', 'team@projecthub.test', 'alerts@statusping.test', 'digest@readwise.test', 'sales@vendor.test'];
const topics = ['Weekly update', 'Your order shipped', 'Action required', 'Meeting notes', 'Invoice ready', 'New comment', 'Reminder', 'Report', 'Newsletter', 'Payment received'];

let sent = 0;
for (let i = 0; i < N; i++) {
  const from = senders[i % senders.length];
  const subject = `${topics[i % topics.length]} #${i + 1}`;
  // spread dates over the past ~50 days so the list sorts realistically
  const date = new Date(Date.UTC(2026, 5, 22) - i * 4 * 3600 * 1000);
  await smtp.sendMail({
    from: `"${from.split('@')[0]}" <${from}>`,
    to: 'alice@demo.test',
    subject,
    text: `Bulk test message number ${i + 1}. Body content for pagination testing.`,
    date,
  });
  if (++sent % 50 === 0) console.log(`sent ${sent}/${N}`);
}
console.log(`Done: sent ${sent} bulk messages to alice@demo.test.`);
