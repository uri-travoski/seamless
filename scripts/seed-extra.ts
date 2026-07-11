/* Extra demo mail with real attachments (lands in the inbox via sync).
   Run: node --import tsx scripts/seed-extra.ts */
import nodemailer from 'nodemailer';

const smtp = nodemailer.createTransport({ host: 'localhost', port: 3026, secure: false, tls: { rejectUnauthorized: false } });

const pdf = (title: string) =>
  Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n% ${title}\ntrailer<<>>\n%%EOF`);
const png1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');
const csv = Buffer.from('milestone,owner,due\nDesign,Marta,2026-08-01\nBeta,Alice,2026-09-15\nLaunch,Team,2026-10-30\n');

interface Att { filename: string; content: Buffer; contentType: string }
interface Seed { from: string; to: string; subject: string; text: string; attachments: Att[] }

const mails: Seed[] = [
  {
    from: '"Cloud Billing" <billing@hostcorp.test>', to: 'alice@demo.test',
    subject: 'Invoice #4102 for October',
    text: 'Your October invoice is attached. Total: $41.02, due Nov 20.',
    attachments: [{ filename: 'invoice-4102.pdf', content: pdf('Invoice 4102'), contentType: 'application/pdf' }],
  },
  {
    from: '"Marta Klein" <marta@kleinconsult.test>', to: 'alice@demo.test',
    subject: 'Kickoff pack: notes + milestone sheet',
    text: 'Hi Alice,\n\nAttached the kickoff notes and the milestone sheet we agreed on.\n\nMarta',
    attachments: [
      { filename: 'kickoff-notes.pdf', content: pdf('Kickoff notes'), contentType: 'application/pdf' },
      { filename: 'milestones.csv', content: csv, contentType: 'text/csv' },
    ],
  },
  {
    from: '"Design Team" <design@studio.test>', to: 'alice@demo.test',
    subject: 'Homepage mockups v3',
    text: 'Latest homepage mockup attached. Feedback by Friday please.',
    attachments: [{ filename: 'homepage-v3.png', content: png1x1, contentType: 'image/png' }],
  },
];

for (const m of mails) {
  await smtp.sendMail({ from: m.from, to: m.to, subject: m.subject, text: m.text, attachments: m.attachments });
  console.log(`sent: ${m.subject} (${m.attachments.length} attachment(s)) -> ${m.to}`);
}
console.log(`Seeded ${mails.length} messages with attachments.`);
