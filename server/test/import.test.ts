import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetDb, TEST_USER } from './helpers.ts';
import { q, one } from '../src/db.ts';
import { importWorkbook } from '../src/import/xlsx.ts';
import { allUserSettings } from '../src/classify/settings.ts';

// the real spreadsheet is the source of truth (repo root)
const SHEET = path.resolve(fileURLToPath(import.meta.url), '../../../Gmail-Rules-Sheet.xlsx');

describe('spreadsheet importer (real Gmail-Rules-Sheet.xlsx)', () => {
  let buf: Buffer;

  beforeAll(async () => {
    await resetDb();
    buf = fs.readFileSync(SHEET);
  });

  it('dry-run previews without writing', async () => {
    const preview = await importWorkbook(TEST_USER, buf, false);
    expect(preview.labels.length).toBeGreaterThan(30);
    expect(preview.rules.length).toBeGreaterThan(140); // 137 sheet rules + 12 via/ source rules
    expect(preview.preferences.length).toBeGreaterThanOrEqual(12);
    expect((await q('SELECT * FROM labels WHERE user_id = ?', [TEST_USER])).length).toBe(0);
    expect((await q('SELECT * FROM rules WHERE user_id = ?', [TEST_USER])).length).toBe(0);
  });

  it('commit imports labels with retention semantics from the Settings tab', async () => {
    await importWorkbook(TEST_USER, buf, true);

    const labels = await q<any>('SELECT * FROM labels WHERE user_id = ?', [TEST_USER]);
    const byName = new Map(labels.map((l: any) => [l.name, l]));

    expect(byName.get('To Delete')?.retention_days).toBe(60);
    expect(byName.get('Sale')?.retention_days).toBe(10);        // own retention wins over To-Delete hack
    expect(byName.get('Sale')?.auto_mark_read).toBe(true);      // "Add To Delete to labels" -> transient
    expect(byName.get('School')?.retention_days).toBe(60);      // inherits To Delete days
    expect(byName.get('To Keep/Keep 1 year')?.retention_days).toBe(365);
    expect(byName.get('To Keep/keep 2 years')?.retention_days).toBe(730);
    expect(byName.get('To Keep/Keep long term')?.keep_default).toBe(true);
    expect(byName.get('To Keep/Keep long term')?.protected).toBe(true);
    expect(byName.get('Banking/Statements')?.protected).toBe(true);
    expect(byName.get('Staff Documents')?.protected).toBe(true);

    // hierarchy: "To Keep/Keep 1 year/Tickets" hangs off "To Keep/Keep 1 year"
    expect(byName.get('To Keep/Keep 1 year/Tickets')?.parent_id).toBe(byName.get('To Keep/Keep 1 year')?.id);
  });

  it('imports rules: AI-routing, exclusions, via/ source rules', async () => {
    const rules = await q<any>('SELECT r.*, l.name AS label_name FROM rules r LEFT JOIN labels l ON l.id = r.label_id WHERE r.user_id = ?', [TEST_USER]);
    expect(rules.length).toBeGreaterThan(140);

    const stripe = rules.find((r: any) => r.match_value === 'stripe.com');
    expect(stripe?.match_field).toBe('from_domain');
    expect(stripe?.label_name).toBe('Receipts');

    const ali = rules.find((r: any) => r.match_value === 'transaction@notice.aliexpress.com');
    expect(ali?.action).toBe('ai');
    expect(ali?.label_id).toBe(null);

    const promo = rules.find((r: any) => r.match_field === 'category');
    expect(promo?.match_value).toBe('promotions');
    expect(promo?.exclude_contains).toContain('invoice');

    const via = rules.filter((r: any) => r.match_field === 'delivered_to');
    expect(via.length).toBe(12);
    expect(via.every((r: any) => r.stop === false && r.ord === -100)).toBe(true);
    expect(via.some((r: any) => r.match_value === 'reallybasic@gmail.com' && r.label_name === 'via/reallybasic')).toBe(true);
  });

  it('imports preferences and settings', async () => {
    const prefs = await q<any>('SELECT * FROM preferences WHERE user_id = ?', [TEST_USER]);
    expect(prefs.length).toBeGreaterThanOrEqual(12);
    expect(prefs.some((p: any) => /terms-of-service/i.test(p.guidance))).toBe(true);

    const settings = await allUserSettings(TEST_USER);
    expect(settings.dry_run).toBe('true');
    expect(settings.ai_conf_threshold).toBe('0.7');
    expect(settings.ai_model).toBe('gemini-2.5-flash-lite');
  });

  it('imports forwarding-out routes', async () => {
    const routes = await q<any>('SELECT r.*, l.name AS label_name FROM routes r JOIN labels l ON l.id = r.label_id WHERE r.user_id = ?', [TEST_USER]);
    expect(routes.length).toBeGreaterThanOrEqual(6);
    expect(routes.some((r: any) => r.label_name === 'Receipts' && r.forward_to === 'reallybasic.receipts@gmail.com')).toBe(true);
  });

  it('re-import is idempotent', async () => {
    const before = {
      labels: (await q('SELECT * FROM labels WHERE user_id = ?', [TEST_USER])).length,
      rules: (await q('SELECT * FROM rules WHERE user_id = ?', [TEST_USER])).length,
      prefs: (await q('SELECT * FROM preferences WHERE user_id = ?', [TEST_USER])).length,
    };
    const preview = await importWorkbook(TEST_USER, buf, true);
    expect(preview.labels.every((l) => !l.create)).toBe(true);
    expect(preview.rules.every((r) => !r.create)).toBe(true);
    const after = {
      labels: (await q('SELECT * FROM labels WHERE user_id = ?', [TEST_USER])).length,
      rules: (await q('SELECT * FROM rules WHERE user_id = ?', [TEST_USER])).length,
      prefs: (await q('SELECT * FROM preferences WHERE user_id = ?', [TEST_USER])).length,
    };
    expect(after).toEqual(before);
  });
});
