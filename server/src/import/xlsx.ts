import ExcelJS from 'exceljs';
import { q, one, run, insertId } from '../db.ts';
import { setUserSetting, plog } from '../classify/settings.ts';

/**
 * Spreadsheet importer — the sheet's tabs ARE the config schema (DESIGN.md §6).
 * Tabs: Labels, Rules, Settings, Preferences, Forwarding Accounts, Forwarding Out.
 * Idempotent: labels match by name, rules by (field, value, action target),
 * preferences by guidance text, routes by (label, forward_to).
 */

export interface ImportPreview {
  labels: { name: string; create: boolean; retentionDays: number | null; keepDefault: boolean; protected: boolean; autoMarkRead: boolean }[];
  rules: { ord: number; field: string; value: string; action: string; label: string | null; create: boolean }[];
  preferences: { guidance: string; create: boolean }[];
  routes: { label: string; forwardTo: string; create: boolean }[];
  settings: Record<string, string>;
  warnings: string[];
}

const FIELD_MAP: Record<string, string> = {
  'from': 'from',
  'from-domain': 'from_domain',
  'to': 'to',
  'delivered-to': 'delivered_to',
  'subject contains': 'subject_contains',
  'body contains': 'body_contains',
  'header': 'header',
  'list-id': 'list_id',
  'category': 'category',
};

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if ('text' in (v as any)) return String((v as any).text ?? '');
    if ('result' in (v as any)) return String((v as any).result ?? '');
    if ('richText' in (v as any)) return (v as any).richText.map((r: any) => r.text).join('');
  }
  return String(v);
}

function rowsOf(ws: ExcelJS.Worksheet): string[][] {
  const out: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals: string[] = [];
    for (let c = 1; c <= ws.columnCount; c++) vals.push(cellText(row.getCell(c).value).trim());
    out.push(vals);
  });
  return out;
}

function truthy(s: string): boolean {
  return /^(true|yes|on|1)$/i.test(s.trim());
}

interface ParsedSheet {
  labels: Map<string, { description: string }>;
  rules: { enabled: boolean; ord: number; field: string; value: string; exclude: string; applyLabel: string; stop: boolean; note: string }[];
  preferences: string[];
  settings: [string, string][];
  forwardingAccounts: { address: string; label: string }[];
  forwardingOut: { label: string; forwardTo: string; onlyAfter: number | null; note: string }[];
  warnings: string[];
}

export async function parseWorkbook(buf: Buffer): Promise<ParsedSheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const out: ParsedSheet = { labels: new Map(), rules: [], preferences: [], settings: [], forwardingAccounts: [], forwardingOut: [], warnings: [] };

  const get = (name: string) => wb.worksheets.find((w) => w.name.toLowerCase() === name.toLowerCase());

  const labelsWs = get('Labels');
  if (labelsWs) {
    for (const r of rowsOf(labelsWs).slice(1)) {
      const [name, , purpose] = r;
      if (!name || name.toLowerCase() === 'label') continue;
      out.labels.set(name, { description: purpose ?? '' });
    }
  } else out.warnings.push('No "Labels" tab found');

  const rulesWs = get('Rules');
  if (rulesWs) {
    for (const r of rowsOf(rulesWs).slice(1)) {
      const [enabled, ord, field, value, exclude, applyLabel, stop, note] = r;
      if (!field || !value || !applyLabel) continue;
      const mapped = FIELD_MAP[field.trim().toLowerCase()];
      if (!mapped) { out.warnings.push(`Rules: unknown Match Field "${field}" (row skipped)`); continue; }
      out.rules.push({
        enabled: truthy(enabled), ord: Number(ord) || 0, field: mapped, value: value.trim(),
        exclude: exclude ?? '', applyLabel: applyLabel.trim(), stop: stop === '' ? true : truthy(stop), note: note ?? '',
      });
    }
  } else out.warnings.push('No "Rules" tab found');

  const prefWs = get('Preferences');
  if (prefWs) {
    for (const r of rowsOf(prefWs).slice(1)) {
      const [enabled, guidance] = r;
      if (!guidance || !truthy(enabled)) continue;
      out.preferences.push(guidance.trim());
    }
  }

  const settingsWs = get('Settings');
  if (settingsWs) {
    for (const r of rowsOf(settingsWs).slice(1)) {
      const [key, value] = r;
      if (!key || key.toLowerCase() === 'setting') continue;
      out.settings.push([key.trim(), (value ?? '').trim()]);
    }
  }

  const fwdWs = get('Forwarding Accounts');
  if (fwdWs) {
    for (const r of rowsOf(fwdWs).slice(1)) {
      const [enabled, address, label] = r;
      if (!truthy(enabled) || !address || !label || !address.includes('@')) continue;
      out.forwardingAccounts.push({ address: address.trim(), label: label.trim() });
    }
  }

  const outWs = get('Forwarding Out');
  if (outWs) {
    for (const r of rowsOf(outWs).slice(1)) {
      const [enabled, label, forwardTo, onlyAfter, note] = r;
      if (!truthy(enabled) || !label || !forwardTo || !forwardTo.includes('@')) continue;
      const t = onlyAfter ? Date.parse(onlyAfter.replace(/\//g, '-')) : NaN;
      out.forwardingOut.push({ label: label.trim(), forwardTo: forwardTo.trim(), onlyAfter: isNaN(t) ? null : t, note: note ?? '' });
    }
  }

  return out;
}

/** Settings-tab semantics -> per-label retention + user settings. */
function deriveLabelConfig(parsed: ParsedSheet): Map<string, { retentionDays: number | null; keepDefault: boolean; protected: boolean; autoMarkRead: boolean }> {
  const cfg = new Map<string, { retentionDays: number | null; keepDefault: boolean; protected: boolean; autoMarkRead: boolean }>();
  const ensure = (name: string) => {
    if (!cfg.has(name)) cfg.set(name, { retentionDays: null, keepDefault: false, protected: false, autoMarkRead: false });
    return cfg.get(name)!;
  };
  for (const name of parsed.labels.keys()) ensure(name);

  let toDeleteDays = 60;
  const transient: string[] = [];
  for (const [key, value] of parsed.settings) {
    const m = key.match(/^Retention:\s*(.+)$/i);
    if (m) {
      const label = m[1].trim();
      if (/^keep$/i.test(value)) {
        const c = ensure(label);
        c.keepDefault = true;
      } else {
        const days = Number(value);
        if (Number.isFinite(days) && days > 0) {
          ensure(label).retentionDays = days;
          if (/^to delete$/i.test(label)) toDeleteDays = days;
        }
      }
      continue;
    }
    if (/^Protected labels/i.test(key)) {
      for (const name of value.split(',').map((s) => s.trim()).filter(Boolean)) ensure(name).protected = true;
      continue;
    }
    if (/^Add To Delete to labels/i.test(key)) {
      transient.push(...value.split(',').map((s) => s.trim()).filter(Boolean));
      continue;
    }
  }
  // "Add To Delete to labels" hack -> the label carries the retention directly (+ transient = auto-read)
  for (const name of transient) {
    const c = ensure(name);
    if (c.retentionDays === null) c.retentionDays = toDeleteDays;
    c.autoMarkRead = true;
  }
  return cfg;
}

const SETTINGS_KEY_MAP: [RegExp, string][] = [
  [/^Dry run$/i, 'dry_run'],
  [/^AI confidence threshold$/i, 'ai_conf_threshold'],
  [/^AI model$/i, 'ai_model'],
  [/^AI fallback$/i, 'ai_fallback'],
  [/^Batch size per run$/i, 'batch_size'],
];

export async function importWorkbook(userId: number, buf: Buffer, commit: boolean): Promise<ImportPreview> {
  const parsed = await parseWorkbook(buf);
  const labelCfg = deriveLabelConfig(parsed);

  // every label referenced anywhere gets created
  const referenced = new Set<string>([...parsed.labels.keys(), ...labelCfg.keys()]);
  for (const r of parsed.rules) if (r.applyLabel && r.applyLabel.toUpperCase() !== 'AI') referenced.add(r.applyLabel);
  for (const f of parsed.forwardingAccounts) referenced.add(f.label);
  for (const f of parsed.forwardingOut) referenced.add(f.label);

  const existingLabels = new Map((await q<{ id: number; name: string }>('SELECT id, name FROM labels WHERE user_id = ?', [userId]))
    .map((l) => [l.name.toLowerCase(), l]));

  const preview: ImportPreview = { labels: [], rules: [], preferences: [], routes: [], settings: {}, warnings: parsed.warnings };

  const PALETTE = ['#e05656', '#e88b3a', '#c9a13a', '#4d9e53', '#3a9e9e', '#2f7ed8', '#7a5fd0', '#d05f8e', '#8a939c', '#5b6570'];
  let colorIdx = 0;
  const labelIds = new Map<string, number>();

  // parents first so `parent_id` can resolve ("To Keep/Keep 1 year/Tickets")
  const ordered = [...referenced].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  for (const name of ordered) {
    const cfg = labelCfg.get(name) ?? { retentionDays: null, keepDefault: false, protected: false, autoMarkRead: false };
    const existing = existingLabels.get(name.toLowerCase());
    preview.labels.push({ name, create: !existing, retentionDays: cfg.retentionDays, keepDefault: cfg.keepDefault, protected: cfg.protected, autoMarkRead: cfg.autoMarkRead });
    if (!commit) continue;

    const description = parsed.labels.get(name)?.description ?? '';
    const parentName = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : null;
    const parentId = parentName ? labelIds.get(parentName) ?? existingLabels.get(parentName.toLowerCase())?.id ?? null : null;

    if (existing) {
      await run(`
        UPDATE labels SET description = COALESCE(NULLIF(?, ''), description), parent_id = ?,
          keep_default = ?, retention_days = ?, protected = ?, auto_mark_read = ?
        WHERE id = ?
      `, [description, parentId, cfg.keepDefault, cfg.retentionDays, cfg.protected, cfg.autoMarkRead, existing.id]);
      labelIds.set(name, existing.id);
    } else {
      const id = await insertId(`
        INSERT INTO labels(user_id, name, color, description, sort, parent_id, keep_default, retention_days, protected, auto_mark_read)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `, [userId, name, PALETTE[colorIdx++ % PALETTE.length], description, 0, parentId, cfg.keepDefault, cfg.retentionDays, cfg.protected, cfg.autoMarkRead]);
      labelIds.set(name, id);
      existingLabels.set(name.toLowerCase(), { id, name });
    }
  }
  const labelId = (name: string) => labelIds.get(name) ?? existingLabels.get(name.toLowerCase())?.id ?? null;

  // rules — forwarding-account source labels first (non-stopping, run before everything)
  const existingRules = await q<any>('SELECT * FROM rules WHERE user_id = ?', [userId]);
  const ruleKey = (field: string, value: string, action: string, lid: number | null) =>
    `${field}|${value.toLowerCase()}|${action}|${lid ?? ''}`;
  const existingKeys = new Set(existingRules.map((r: any) => ruleKey(r.match_field, r.match_value, r.action, r.label_id)));

  const addRule = async (spec: { enabled: boolean; ord: number; field: string; value: string; exclude: string; action: 'label' | 'ai'; labelName: string | null; stop: boolean; note: string }) => {
    const lid = spec.labelName ? labelId(spec.labelName) : null;
    // in dry-run the labels haven't been created yet — a referenced label counts as resolvable
    if (spec.action === 'label' && !lid && !(spec.labelName && referenced.has(spec.labelName))) {
      preview.warnings.push(`Rule for "${spec.value}": label "${spec.labelName}" missing`);
      return;
    }
    const key = ruleKey(spec.field, spec.value, spec.action, spec.action === 'label' ? lid : null);
    const create = !existingKeys.has(key);
    preview.rules.push({ ord: spec.ord, field: spec.field, value: spec.value, action: spec.action, label: spec.labelName, create });
    if (!commit || !create) return;
    existingKeys.add(key);
    await insertId(`
      INSERT INTO rules(user_id, enabled, ord, match_field, match_value, exclude_contains, action, label_id, stop, note, source, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `, [userId, spec.enabled, spec.ord, spec.field, spec.value, spec.exclude, spec.action, spec.action === 'label' ? lid : null, spec.stop, spec.note, 'imported', Date.now()]);
  };

  for (const f of parsed.forwardingAccounts) {
    await addRule({ enabled: true, ord: -100, field: 'delivered_to', value: f.address, exclude: '', action: 'label', labelName: f.label, stop: false, note: 'source (via/) label from Forwarding Accounts tab' });
  }
  for (const r of parsed.rules) {
    const isAi = r.applyLabel.toUpperCase() === 'AI';
    await addRule({ enabled: r.enabled, ord: r.ord, field: r.field, value: r.value, exclude: r.exclude, action: isAi ? 'ai' : 'label', labelName: isAi ? null : r.applyLabel, stop: r.stop, note: r.note });
  }

  // preferences
  const existingPrefs = new Set((await q<{ guidance: string }>('SELECT guidance FROM preferences WHERE user_id = ?', [userId])).map((p) => p.guidance));
  for (const g of parsed.preferences) {
    const create = !existingPrefs.has(g);
    preview.preferences.push({ guidance: g, create });
    if (commit && create) {
      await insertId('INSERT INTO preferences(user_id, enabled, guidance, version, active, created_at) VALUES (?,?,?,1,true,?)', [userId, true, g, Date.now()]);
    }
  }

  // settings
  for (const [key, value] of parsed.settings) {
    const mapped = SETTINGS_KEY_MAP.find(([re]) => re.test(key));
    if (!mapped) continue;
    const v = /^(true|false)$/i.test(value) ? value.toLowerCase() : truthy(value) && !/^\d/.test(value) ? 'true' : value;
    preview.settings[mapped[1]] = v;
    if (commit) await setUserSetting(userId, mapped[1], v);
  }

  // forwarding out -> routes (engine is a later phase; config is preserved now)
  const existingRoutes = await q<any>('SELECT r.*, l.name AS label_name FROM routes r LEFT JOIN labels l ON l.id = r.label_id WHERE r.user_id = ?', [userId]);
  for (const f of parsed.forwardingOut) {
    const create = !existingRoutes.some((r: any) => r.label_name === f.label && r.forward_to === f.forwardTo);
    preview.routes.push({ label: f.label, forwardTo: f.forwardTo, create });
    if (commit && create) {
      const lid = labelId(f.label);
      if (lid) await insertId('INSERT INTO routes(user_id, enabled, label_id, forward_to, only_after, note) VALUES (?,?,?,?,?,?)', [userId, true, lid, f.forwardTo, f.onlyAfter, f.note]);
    }
  }

  if (commit) {
    await plog(userId, 'import', `spreadsheet imported: ${preview.labels.filter((l) => l.create).length} new labels, ${preview.rules.filter((r) => r.create).length} new rules, ${preview.preferences.filter((p) => p.create).length} new preferences`);
  }
  return preview;
}
