import type { MailboxRole } from '@seamless/shared';

const nameMap: [RegExp, MailboxRole][] = [
  [/^inbox$/i, 'inbox'],
  [/^(sent|sent items|sent messages|sent mail)$/i, 'sent'],
  [/^(drafts?)$/i, 'drafts'],
  [/^(scheduled|scheduled send|snoozed|outbox)$/i, 'scheduled'],
  [/^(trash|deleted|deleted items|deleted messages|bin)$/i, 'trash'],
  [/^(junk|spam|junk e-?mail)$/i, 'junk'],
  [/^(archive|archives|all mail)$/i, 'archive'],
];

const specialUseMap: Record<string, MailboxRole> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
  '\\All': 'archive',
};

export function detectRole(path: string, name: string, specialUse?: string): MailboxRole {
  if (specialUse && specialUseMap[specialUse]) return specialUseMap[specialUse];
  if (path.toUpperCase() === 'INBOX') return 'inbox';
  for (const [re, role] of nameMap) {
    if (re.test(name) || re.test(path)) return role;
  }
  return null;
}
