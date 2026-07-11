import type { ApiAddress, ApiIdentity } from '@seamless/shared';

export interface AccountIdentityInfo {
  accountId: number;
  email: string;
  name: string;
  aliases: string[];
}

/**
 * Pick the identity to reply from: the address this message was actually
 * delivered to. Priority: Delivered-To header, then To, then Cc, matched
 * (case-insensitive) against each account's primary address and aliases.
 * Falls back to the account that owns the mailbox the message lives in.
 */
export function matchReplyIdentity(args: {
  deliveredTo: string | null;
  to: ApiAddress[];
  cc: ApiAddress[];
  owningAccountId: number;
  accounts: AccountIdentityInfo[];
}): ApiIdentity {
  const candidates: string[] = [];
  if (args.deliveredTo) candidates.push(args.deliveredTo);
  for (const a of args.to) candidates.push(a.email);
  for (const a of args.cc) candidates.push(a.email);

  for (const cand of candidates) {
    const lc = cand.trim().toLowerCase();
    if (!lc) continue;
    for (const acct of args.accounts) {
      if (acct.email.toLowerCase() === lc) {
        return { accountId: acct.accountId, email: acct.email, name: acct.name, isAlias: false };
      }
      const alias = acct.aliases.find((al) => al.toLowerCase() === lc);
      if (alias) {
        return { accountId: acct.accountId, email: alias, name: acct.name, isAlias: true };
      }
    }
  }

  const owner = args.accounts.find((a) => a.accountId === args.owningAccountId) ?? args.accounts[0];
  return { accountId: owner.accountId, email: owner.email, name: owner.name, isAlias: false };
}
