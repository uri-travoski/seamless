import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { ApiLabel } from '@seamless/shared';
import { useMail } from '../state/mail.ts';
import { api } from '../api/client.ts';
import { toast } from '../toast.ts';

// Shared label palette (Synology-style: 14 hues x light/mid/dark). Used by the
// settings label editor and the inline color dots in the settings list + sidebar.
export const LABEL_COLORS = [
  // light
  '#cbd0d6', '#f3b0ad', '#f6c3a6', '#f7d7a1', '#efe6a0', '#cfe6a4', '#aeddb0',
  '#a6ddd3', '#a9d8e6', '#abd0ec', '#b3bfe8', '#c3b6e6', '#dbb3e0', '#f2b0c9',
  // mid
  '#8a939c', '#ef5a56', '#f0754a', '#f0a838', '#dcc02a', '#8cbf3f', '#4fae54',
  '#2fae9e', '#2aa9d0', '#2f8ed8', '#3a63d0', '#7a5fd0', '#b04fc0', '#e05a8e',
  // dark
  '#3a4149', '#c0392b', '#d15828', '#cf7a10', '#a89a10', '#5f8f2a', '#2f8f3a',
  '#1f8f80', '#1a89b0', '#1f6ec0', '#2a45b0', '#5a3fb0', '#8a2f9c', '#b02f6e',
];
export const DEFAULT_LABEL_COLOR = '#2f8ed8';

/** WCAG relative luminance → pick dark or white ink so label text stays readable
 *  on both pastel and saturated chips. */
function luminance(hex: string): number {
  const c = hex.replace('#', '');
  const chan = [0, 2, 4].map((i) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
}
export function readableTextOn(hex: string): string {
  try {
    return luminance(hex) > 0.45 ? '#1f2430' : '#ffffff';
  } catch {
    return '#ffffff';
  }
}

type LabelLike = ApiLabel & { sort?: number };
const POP_W = 14 * 22 + 13 * 4 + 16; // 14 swatches + gaps + padding

/** Color dot that opens the shared palette on click and saves the picked color.
 *  The popover is position:fixed so it never clips inside scroll containers
 *  (settings panel, sidebar). Pass `stop` inside a clickable row to keep the
 *  dot from triggering the row's own click. */
export default function LabelColorPicker({ label, dotSize = 14, stop, className }: {
  label: LabelLike; dotSize?: number; stop?: boolean; className?: string;
}) {
  const refreshLabels = useMail((s) => s.refreshLabels);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);

  const openAt = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - POP_W));
    setAnchor({ left, top: r.bottom + 4 });
  };

  const changeColor = async (color: string) => {
    setAnchor(null);
    if (label.color === color) return;
    try {
      await api.put(`/api/labels/${label.id}`, {
        name: label.name, color, description: label.description, sort: label.sort ?? 0,
        keepDefault: !!label.keepDefault, retentionDays: label.retentionDays ?? null,
        protected: !!label.protected, autoMarkRead: !!label.autoMarkRead,
      });
      await refreshLabels();
    } catch (e: any) {
      toast(e?.message ?? 'Color change failed', 'error');
    }
  };

  return (
    <span className={`label-color ${className ?? ''}`} style={{ display: 'inline-flex', flex: '0 0 auto' }}>
      <button className="label-dot dot-btn" style={{ background: label.color, width: dotSize, height: dotSize }}
        title="Change color" aria-label={`Change color for ${label.name}`}
        onClick={(e) => { if (stop) e.stopPropagation(); anchor ? setAnchor(null) : openAt(e.currentTarget); }} />
      {anchor && createPortal(
        <>
          <div className="color-pop-backdrop" style={{ zIndex: 210 }}
            onClick={(e) => { if (stop) e.stopPropagation(); setAnchor(null); }} />
          <div className="color-pop" style={{ position: 'fixed', left: anchor.left, top: anchor.top, zIndex: 211 }}>
            {LABEL_COLORS.map((c) => (
              <button key={c} className="swatch-mini" style={{ background: c }} title={c} aria-label={c}
                onClick={(e) => { if (stop) e.stopPropagation(); void changeColor(c); }} />
            ))}
          </div>
        </>,
        document.body,
      )}
    </span>
  );
}
