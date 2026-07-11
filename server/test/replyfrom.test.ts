import { describe, it, expect } from 'vitest';
import { matchReplyIdentity } from '../src/mail/replyfrom.ts';

const accounts = [
  { accountId: 1, email: 'personal@demo.test', name: 'Me', aliases: [] },
  { accountId: 2, email: 'support@demo.test', name: 'Support', aliases: ['help@demo.test'] },
];

describe('reply-from identity matching', () => {
  it('matches Delivered-To first', () => {
    const id = matchReplyIdentity({
      deliveredTo: 'support@demo.test',
      to: [{ name: '', email: 'personal@demo.test' }],
      cc: [],
      owningAccountId: 1,
      accounts,
    });
    expect(id.email).toBe('support@demo.test');
    expect(id.accountId).toBe(2);
  });

  it('falls back to To match, case-insensitive', () => {
    const id = matchReplyIdentity({
      deliveredTo: null,
      to: [{ name: '', email: 'SUPPORT@Demo.Test' }],
      cc: [],
      owningAccountId: 1,
      accounts,
    });
    expect(id.accountId).toBe(2);
  });

  it('matches aliases and reports isAlias', () => {
    const id = matchReplyIdentity({
      deliveredTo: null,
      to: [{ name: '', email: 'help@demo.test' }],
      cc: [],
      owningAccountId: 1,
      accounts,
    });
    expect(id.email).toBe('help@demo.test');
    expect(id.isAlias).toBe(true);
    expect(id.accountId).toBe(2);
  });

  it('matches Cc when To has no known address', () => {
    const id = matchReplyIdentity({
      deliveredTo: null,
      to: [{ name: '', email: 'other@x.test' }],
      cc: [{ name: '', email: 'support@demo.test' }],
      owningAccountId: 1,
      accounts,
    });
    expect(id.accountId).toBe(2);
  });

  it('falls back to the owning account when nothing matches', () => {
    const id = matchReplyIdentity({
      deliveredTo: null,
      to: [{ name: '', email: 'list@list.test' }],
      cc: [],
      owningAccountId: 2,
      accounts,
    });
    expect(id.accountId).toBe(2);
    expect(id.email).toBe('support@demo.test');
  });
});
