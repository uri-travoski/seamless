/** Storage-used bar: neutral under 80 %, amber from 80 %, red from 100 % (theme tokens only). */
import { formatBytes } from '../Sidebar.tsx';

export type QuotaLevel = 'ok' | 'warn' | 'full' | 'none';
export const quotaLevel = (percent: number | null): QuotaLevel => (percent == null ? 'none' : percent >= 100 ? 'full' : percent >= 80 ? 'warn' : 'ok');

const FILL: Record<QuotaLevel, string> = {
  none: 'var(--md-text-faint)', ok: 'var(--color-success)', warn: 'var(--color-warning)', full: 'var(--color-danger)',
};

export default function QuotaBar({ usedBytes, quotaBytes, percent, wide }: { usedBytes: number; quotaBytes: number | null; percent: number | null; wide?: boolean }) {
  const level = quotaLevel(percent);
  return (
    <div className={`quota-bar quota-${level}`} style={{ minWidth: wide ? 260 : 150 }}>
      <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent == null ? undefined : Math.min(100, Math.round(percent))}
        aria-label="Storage used" style={{ height: 8, borderRadius: 4, background: 'var(--md-border)', overflow: 'hidden' }}>
        {percent != null && <div style={{ width: `${Math.min(100, percent)}%`, height: '100%', background: FILL[level] }} />}
      </div>
      <div style={{ fontSize: 12, marginTop: 3, color: level === 'full' ? 'var(--color-danger)' : level === 'warn' ? 'var(--color-warning)' : 'var(--md-text-soft)' }}>
        {formatBytes(usedBytes)}{quotaBytes ? ` of ${formatBytes(quotaBytes)} (${Math.round(percent ?? 0)}%)` : ' · no limit'}
      </div>
    </div>
  );
}
