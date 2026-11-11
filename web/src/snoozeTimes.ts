/** Snooze presets, computed on the Perth wall clock (the user's time zone) whatever the browser's zone is. */
export const SNOOZE_TZ = 'Australia/Perth';

interface Parts { y: number; mo: number; d: number; h: number; mi: number; dow: number }

function partsAt(ms: number, tz = SNOOZE_TZ): Parts {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday);
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, dow };
}

/** Wall-clock time in `tz` → epoch ms (day overflow is fine: Date.UTC normalises it). */
export function zonedToEpoch(y: number, mo: number, d: number, h: number, mi: number, tz = SNOOZE_TZ): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const p = partsAt(guess, tz);
  const asIfUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  return guess - (asIfUtc - guess);
}

export interface SnoozePreset { id: string; label: string; at: number }

export function snoozePresets(now = Date.now()): SnoozePreset[] {
  const p = partsAt(now);
  const at = (addDays: number, h: number) => zonedToEpoch(p.y, p.mo, p.d + addDays, h, 0);
  const out: SnoozePreset[] = [];

  const later = Math.ceil((now + 3 * 3_600_000) / 3_600_000) * 3_600_000;
  out.push({ id: 'later', label: 'Later today', at: later });

  const tonight = at(0, 18);
  if (tonight > now + 60_000) out.push({ id: 'tonight', label: 'This evening', at: tonight });

  out.push({ id: 'tomorrow', label: 'Tomorrow', at: at(1, 8) });

  if (p.dow >= 1 && p.dow <= 5) out.push({ id: 'weekend', label: 'This weekend', at: at(6 - p.dow, 8) });

  const toMonday = ((8 - p.dow) % 7) || 7;
  out.push({ id: 'nextweek', label: 'Next week', at: at(toMonday, 8) });

  out.push({ id: 'someday', label: 'Someday (30 days)', at: at(30, 8) });
  return out.filter((x) => x.at > now + 60_000);
}

/** "Mon 8:00 am" style, in Perth time. */
export function fmtSnooze(ms: number): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone: SNOOZE_TZ, weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(ms));
}

/** Longer form for toasts and the Snoozed list: "Mon 14 Jul, 8:00 am". */
export function fmtSnoozeLong(ms: number): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone: SNOOZE_TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(ms));
}

/** <input type="datetime-local"> value (Perth wall clock) → epoch ms. */
export function fromLocalInput(v: string): number {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? zonedToEpoch(+m[1], +m[2], +m[3], +m[4], +m[5]) : NaN;
}
