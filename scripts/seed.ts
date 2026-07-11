/* Seed GreenMail with demo mail: npm run seed */
import nodemailer from 'nodemailer';

const smtp = nodemailer.createTransport({ host: 'localhost', port: 3026, secure: false, tls: { rejectUnauthorized: false } });

interface Seed {
  from: string; to: string; subject: string; html?: string; text?: string;
  inReplyTo?: string; references?: string[]; messageId?: string; attach?: boolean;
}

const mails: Seed[] = [
  { from: '"GitHub" <notifications@github.com>', to: 'alice@demo.test', subject: '[seamless] PR #12: Fix sync race', text: 'bob-dev requested your review on pull request #12.\n\nFix a race between IDLE wakeups and op flush.' },
  { from: '"Cloud Billing" <billing@hostcorp.test>', to: 'alice@demo.test', subject: 'Invoice #4021 for June', text: 'Your invoice for June is attached. Total: $23.40. Payment due July 20.', attach: true },
  { from: '"Weekly Digest" <newsletter@frontendweekly.test>', to: 'alice@demo.test', subject: 'Frontend Weekly #302', html: '<h2 style="color:#1867c0">Frontend Weekly</h2><p>This week: <b>virtual scrolling</b> deep dive, IndexedDB patterns, and PWA push in 2026.</p><p><img src="https://placekitten.test/banner.jpg" alt="banner"><a href="https://frontendweekly.test/302">Read online</a></p>' },
  { from: '"Marta Klein" <marta@kleinconsult.test>', to: 'alice@demo.test', subject: 'Project kickoff notes', messageId: '<kickoff-1@kleinconsult.test>', text: 'Hi Alice,\n\nGreat call today. Attached the kickoff notes. Milestones: design by Aug 1, beta by Sep 15.\n\nBest,\nMarta' },
  { from: 'alice@demo.test', to: 'marta@kleinconsult.test', subject: 'Re: Project kickoff notes', inReplyTo: '<kickoff-1@kleinconsult.test>', messageId: '<kickoff-2@demo.test>', text: 'Thanks Marta! Aug 1 works. I will send the wireframes Friday.' },
  { from: '"Marta Klein" <marta@kleinconsult.test>', to: 'alice@demo.test', subject: 'Re: Project kickoff notes', inReplyTo: '<kickoff-2@demo.test>', references: ['<kickoff-1@kleinconsult.test>', '<kickoff-2@demo.test>'], text: 'Perfect. One more thing - can we add the reporting module to phase 1?' },
  { from: '"Sam Ortiz" <sam@customer.test>', to: 'support@demo.test', subject: 'Cannot reset my password', text: 'Hello support,\n\nThe reset link says token expired every time. Account: sam@customer.test.\n\nSam' },
  { from: '"Rita Voss" <rita@customer.test>', to: 'support@demo.test', subject: 'Feature request: dark mode', text: 'Please add dark mode to the dashboard. My eyes at 2am beg you.' },
  { from: '"Uptime Bot" <alerts@statusping.test>', to: 'support@demo.test', subject: 'RESOLVED: api.example.com back up', text: 'Downtime: 4m32s. Cause: deploy restart.' },
  { from: '"Nina" <nina@travelmates.test>', to: 'alice@demo.test', subject: 'Lisbon flights in October?', text: 'Found round trips for 89EUR in October. Interested? Dates: Oct 9-14.' },
];

for (let i = 0; i < 12; i++) {
  mails.push({
    from: `"Shop Deals" <deals@shopmail${i % 3}.test>`,
    to: i % 2 ? 'alice@demo.test' : 'support@demo.test',
    subject: `Deal alert #${i + 1}: up to ${10 + i * 5}% off`,
    text: `Limited time offer number ${i + 1}. Use code SAVE${i + 1}.`,
  });
}

const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<<>>\n%%EOF');

for (const m of mails) {
  await smtp.sendMail({
    from: m.from,
    to: m.to,
    subject: m.subject,
    text: m.text,
    html: m.html,
    messageId: m.messageId,
    inReplyTo: m.inReplyTo,
    references: m.references ?? (m.inReplyTo ? [m.inReplyTo] : undefined),
    attachments: m.attach ? [{ filename: 'invoice-4021.pdf', content: pdf, contentType: 'application/pdf' }] : undefined,
  });
  console.log(`sent: ${m.subject} -> ${m.to}`);
}

console.log(`Seeded ${mails.length} messages.`);
