import { describe, it, expect } from 'vitest';
import { parseSearch } from '../src/mail/searchparse.ts';

describe('search query parser', () => {
  it('parses free text into prefix tsquery terms', () => {
    const p = parseSearch('invoice payment');
    expect(p.fts).toBe("'invoice':* & 'payment':*");
  });

  it('parses quoted phrases as adjacency chains', () => {
    const p = parseSearch('"quarterly report" budget');
    expect(p.fts).toBe("('quarterly':* <-> 'report':*) & 'budget':*");
  });

  it('parses structured operators', () => {
    const p = parseSearch('from:github to:me@demo.test label:Work in:inbox is:unread has:attachment hello');
    expect(p.from).toBe('github');
    expect(p.to).toBe('me@demo.test');
    expect(p.label).toBe('Work');
    expect(p.inRole).toBe('inbox');
    expect(p.unread).toBe(true);
    expect(p.hasAttachment).toBe(true);
    expect(p.fts).toBe("'hello':*");
  });

  it('parses quoted operator values', () => {
    const p = parseSearch('label:"Project X"');
    expect(p.label).toBe('Project X');
  });

  it('parses date bounds', () => {
    const p = parseSearch('after:2026-01-01 before:2026-02-01');
    expect(p.after).toBe(Date.parse('2026-01-01'));
    expect(p.before).toBe(Date.parse('2026-02-01'));
  });

  it('is:read and is:starred', () => {
    expect(parseSearch('is:read').unread).toBe(false);
    expect(parseSearch('is:starred').starred).toBe(true);
  });

  it('escapes hostile input into quoted prefix lexemes only', () => {
    const p = parseSearch(`he said "it's fine" !bad | (x)`);
    expect(p.fts).toBeTruthy();
    for (const part of p.fts!.split(' & ')) {
      expect(part).toMatch(/^(\('[^']*':\*( <-> '[^']*':\*)*\)|'[^']*':\*)$/);
    }
  });
});
