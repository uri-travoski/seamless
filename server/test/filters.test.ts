import { describe, it, expect } from 'vitest';
import { conditionMatches, filterMatches, evaluateFilters, type FilterableMessage } from '../src/mail/filters.ts';
import type { ApiFilter } from '@seamless/shared';

const msg: FilterableMessage = {
  from: 'GitHub <notifications@github.com>',
  to: 'Me <me@demo.test>',
  cc: '',
  subject: '[repo] PR #42 merged',
  body: 'Your pull request was merged.',
  hasAttachment: false,
  accountEmail: 'me@demo.test',
};

describe('filter conditions', () => {
  it('contains / not_contains, case-insensitive', () => {
    expect(conditionMatches(msg, { field: 'from', op: 'contains', value: 'GITHUB.COM' })).toBe(true);
    expect(conditionMatches(msg, { field: 'from', op: 'not_contains', value: 'gitlab' })).toBe(true);
    expect(conditionMatches(msg, { field: 'subject', op: 'contains', value: 'merged' })).toBe(true);
  });

  it('equals / starts_with / ends_with', () => {
    expect(conditionMatches(msg, { field: 'account', op: 'equals', value: 'me@demo.test' })).toBe(true);
    expect(conditionMatches(msg, { field: 'subject', op: 'starts_with', value: '[repo]' })).toBe(true);
    expect(conditionMatches(msg, { field: 'from', op: 'ends_with', value: 'github.com>' })).toBe(true);
  });

  it('has_attachment maps to yes/no', () => {
    expect(conditionMatches(msg, { field: 'has_attachment', op: 'equals', value: 'no' })).toBe(true);
  });
});

describe('filter matching', () => {
  const base = { id: 1, name: 'f', enabled: true, sort: 0, stop: false, actions: [] as ApiFilter['actions'] };

  it('all requires every condition', () => {
    expect(filterMatches(msg, { match: 'all', conditions: [
      { field: 'from', op: 'contains', value: 'github' },
      { field: 'subject', op: 'contains', value: 'merged' },
    ]})).toBe(true);
    expect(filterMatches(msg, { match: 'all', conditions: [
      { field: 'from', op: 'contains', value: 'github' },
      { field: 'subject', op: 'contains', value: 'nope' },
    ]})).toBe(false);
  });

  it('any requires one condition', () => {
    expect(filterMatches(msg, { match: 'any', conditions: [
      { field: 'from', op: 'contains', value: 'nope' },
      { field: 'body', op: 'contains', value: 'pull request' },
    ]})).toBe(true);
  });

  it('empty condition list never matches', () => {
    expect(filterMatches(msg, { match: 'all', conditions: [] })).toBe(false);
  });

  it('stop halts later filters; actions accumulate otherwise', () => {
    const filters: ApiFilter[] = [
      { ...base, id: 1, match: 'all', conditions: [{ field: 'from', op: 'contains', value: 'github' }],
        actions: [{ type: 'label', value: '1' }], stop: false },
      { ...base, id: 2, match: 'all', conditions: [{ field: 'subject', op: 'contains', value: 'merged' }],
        actions: [{ type: 'markRead' }], stop: true },
      { ...base, id: 3, match: 'all', conditions: [{ field: 'from', op: 'contains', value: 'github' }],
        actions: [{ type: 'star' }], stop: false },
    ];
    const actions = evaluateFilters(msg, filters);
    expect(actions).toEqual([{ type: 'label', value: '1' }, { type: 'markRead' }]);
  });

  it('disabled filters are skipped', () => {
    const filters: ApiFilter[] = [
      { ...base, id: 1, enabled: false, match: 'all', conditions: [{ field: 'from', op: 'contains', value: 'github' }],
        actions: [{ type: 'star' }], stop: false },
    ];
    expect(evaluateFilters(msg, filters)).toEqual([]);
  });
});
