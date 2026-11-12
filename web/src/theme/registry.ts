/**
 * Theme registry (T0 F-05). A theme is a set of CSS custom properties applied to :root,
 * so switching is instant (no reload) and components only ever read var(--token).
 *
 * - "Seamless" is the original look (light), plus a matching dark variant.
 * - "Rolltop" follows Planning/Rolltop UI/design.md (classic + classic dark): warm paper
 *   neutrals, one terracotta accent, serif display face. Layout/feel only — no Rolltop
 *   name or logo ships with it.
 * - "Simply Seamless" is the content-first light theme.
 */
export type Mode = 'light' | 'dark';
export type Tokens = Record<string, string>;

export interface ThemeDef {
  id: string;
  name: string;
  description: string;
  tokens: { light?: Tokens; dark?: Tokens };   // a theme may support one mode only
  fonts?: string[];                              // Google font families to load (display faces)
  swatch: [string, string, string];              // preview chips in Settings → Appearance
}

/** Every token every theme must define (the list the CSS reads). */
export const TOKEN_NAMES = [
  '--color-bg', '--color-surface', '--color-surface-2', '--color-border', '--color-border-strong',
  '--color-text', '--color-text-strong', '--color-text-soft', '--color-text-muted',
  '--color-accent', '--color-accent-strong', '--color-accent-soft', '--color-accent-contrast', '--color-accent-warm',
  '--color-hover', '--color-selected', '--color-selected-rule', '--color-checked',
  '--color-header-bg', '--color-header-text', '--color-header-search-bg', '--color-header-search-text', '--color-header-rule',
  '--color-sidebar-bg', '--color-sidebar-icon', '--color-ink', '--color-ink-hover', '--color-ink-text',
  '--color-danger', '--color-danger-soft', '--color-critical', '--color-critical-soft', '--color-critical-text', '--color-warning', '--color-warning-soft', '--color-success', '--color-success-soft',
  '--color-unread', '--color-star', '--color-note-bg', '--color-note-border', '--color-note-text',
  '--color-toast-bg', '--color-toast-text', '--color-overlay', '--color-login-bg', '--color-highlight', '--color-focus',
  '--radius-sm', '--radius-md', '--radius-lg', '--shadow-1', '--shadow-2',
  '--font-sans', '--font-display', '--font-mono', '--display-weight',
  '--header-height', '--sidebar-width',
] as const;

const SYSTEM_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

const seamlessLight: Tokens = {
  '--color-bg': '#f4f6f8', '--color-surface': '#ffffff', '--color-surface-2': '#f7f9fb',
  '--color-border': '#e2e6ea', '--color-border-strong': '#bac2c9',
  '--color-text': '#434654', '--color-text-strong': '#191c1e', '--color-text-soft': '#5b6570', '--color-text-muted': '#8a939c',
  '--color-accent': '#1867c0', '--color-accent-strong': '#12508f', '--color-accent-soft': '#e8f1fb', '--color-accent-contrast': '#ffffff', '--color-accent-warm': '#1867c0',
  '--color-hover': '#eef2f6', '--color-selected': '#dcebfb', '--color-selected-rule': 'transparent', '--color-checked': '#fdf3d6',
  '--color-header-bg': '#1b314e', '--color-header-text': '#ffffff', '--color-header-search-bg': 'rgba(255, 255, 255, 0.16)',
  '--color-header-search-text': '#ffffff', '--color-header-rule': 'transparent',
  '--color-sidebar-bg': '#ffffff', '--color-sidebar-icon': '#243959', '--color-ink': '#243959', '--color-ink-hover': '#1b2c47', '--color-ink-text': '#ffffff',
  '--color-critical': '#c8102e', '--color-critical-soft': '#fde7ea', '--color-critical-text': '#ffffff',
  '--color-danger': '#d64541', '--color-danger-soft': '#fdeaea', '--color-warning': '#b26a00', '--color-warning-soft': '#fff8e6',
  '--color-success': '#2f7d4a', '--color-success-soft': '#e3f2e6',
  '--color-unread': '#1e88e5', '--color-star': '#f4b400',
  '--color-note-bg': '#fff8d6', '--color-note-border': '#ecdc94', '--color-note-text': '#4a3d00',
  '--color-toast-bg': '#2c3540', '--color-toast-text': '#ffffff', '--color-overlay': 'rgba(20, 28, 38, 0.45)',
  '--color-login-bg': 'linear-gradient(160deg, #1867c0, #12508f)', '--color-highlight': 'rgba(229, 169, 40, 0.30)', '--color-focus': '#1867c0',
  '--radius-sm': '5px', '--radius-md': '8px', '--radius-lg': '12px',
  '--shadow-1': '0 1px 3px rgba(20, 30, 40, 0.10), 0 4px 14px rgba(20, 30, 40, 0.08)',
  '--shadow-2': '0 6px 18px rgba(20, 30, 40, 0.18), 0 18px 48px rgba(20, 30, 40, 0.16)',
  '--font-sans': SYSTEM_SANS, '--font-display': SYSTEM_SANS, '--font-mono': MONO, '--display-weight': '700',
  '--header-height': '60px', '--sidebar-width': '232px',
};

const seamlessDark: Tokens = {
  ...seamlessLight,
  '--color-bg': '#11161d', '--color-surface': '#18202a', '--color-surface-2': '#1d2631',
  '--color-border': '#2a3441', '--color-border-strong': '#465262',
  '--color-text': '#d6dce4', '--color-text-strong': '#f3f6f9', '--color-text-soft': '#a7b1bd', '--color-text-muted': '#7f8b98',
  '--color-accent': '#3d8de0', '--color-accent-strong': '#9cc8f5', '--color-accent-soft': '#1b3150', '--color-accent-contrast': '#ffffff', '--color-accent-warm': '#3d8de0',
  '--color-hover': '#212b37', '--color-selected': '#1f3858', '--color-checked': '#3a3322',
  '--color-header-bg': '#162236', '--color-header-search-bg': 'rgba(255, 255, 255, 0.10)',
  '--color-sidebar-bg': '#18202a', '--color-sidebar-icon': '#a7b1bd', '--color-ink': '#2a4a78', '--color-ink-hover': '#335a90',
  '--color-critical': '#ff5d6c', '--color-critical-soft': '#4a1820', '--color-critical-text': '#1a0508',
  '--color-danger': '#f07470', '--color-danger-soft': '#3a1f22', '--color-warning': '#f0b45a', '--color-warning-soft': '#342a17',
  '--color-success': '#6ccc8c', '--color-success-soft': '#1b3324',
  '--color-unread': '#5aa9f0', '--color-star': '#f6c343',
  '--color-note-bg': '#3a3418', '--color-note-border': '#5e5426', '--color-note-text': '#f3e7b0',
  '--color-toast-bg': '#e6ebf1', '--color-toast-text': '#11161d', '--color-overlay': 'rgba(0, 0, 0, 0.55)',
  '--color-login-bg': 'linear-gradient(160deg, #162236, #0d1420)', '--color-highlight': 'rgba(224, 182, 77, 0.30)', '--color-focus': '#5aa9f0',
  '--shadow-1': '0 1px 3px rgba(0, 0, 0, 0.40), 0 4px 14px rgba(0, 0, 0, 0.30)',
  '--shadow-2': '0 6px 18px rgba(0, 0, 0, 0.45), 0 18px 48px rgba(0, 0, 0, 0.40)',
};

// Rolltop classic — values from design.md §4.2, button fill darkened to #a85d24 for AA contrast (§10)
const rolltopLight: Tokens = {
  '--color-bg': '#f2f0eb', '--color-surface': '#ffffff', '--color-surface-2': '#f8f6f2',
  '--color-border': '#ded8d1', '--color-border-strong': '#b7b3aa',
  '--color-text': '#202426', '--color-text-strong': '#151f2e', '--color-text-soft': '#4d5652', '--color-text-muted': '#66716d',
  '--color-accent': '#a85d24', '--color-accent-strong': '#151f2e', '--color-accent-soft': '#f6e3da', '--color-accent-contrast': '#ffffff', '--color-accent-warm': '#c46b44',
  '--color-hover': '#efe7e0', '--color-selected': '#e7d8ce', '--color-selected-rule': '#c46b44', '--color-checked': '#f6e3da',
  '--color-header-bg': '#ffffff', '--color-header-text': '#202426', '--color-header-search-bg': '#ece7df',
  '--color-header-search-text': '#202426', '--color-header-rule': 'rgba(196, 107, 68, 0.46)',
  '--color-sidebar-bg': '#f8f6f2', '--color-sidebar-icon': '#66716d', '--color-ink': '#151f2e', '--color-ink-hover': '#24324a', '--color-ink-text': '#ffffff',
  '--color-critical': '#c8102e', '--color-critical-soft': '#fbe3e0', '--color-critical-text': '#ffffff',
  '--color-danger': '#b14532', '--color-danger-soft': '#f8e4df', '--color-warning': '#93482c', '--color-warning-soft': '#f6e3da',
  '--color-success': '#17795f', '--color-success-soft': '#dff1ea',
  '--color-unread': '#c46b44', '--color-star': '#c9962b',
  '--color-note-bg': '#fbf2d9', '--color-note-border': '#e6d3a0', '--color-note-text': '#4a3d00',
  '--color-toast-bg': '#151f2e', '--color-toast-text': '#f1eee9', '--color-overlay': 'rgba(21, 31, 46, 0.45)',
  '--color-login-bg': 'linear-gradient(180deg, #f2f0eb 0%, #e7d8ce 100%)', '--color-highlight': 'rgba(229, 169, 40, 0.26)', '--color-focus': '#c46b44',
  '--radius-sm': '6px', '--radius-md': '8px', '--radius-lg': '12px',
  '--shadow-1': '0 1px 2px rgba(21, 31, 46, 0.13), 0 8px 20px rgba(21, 31, 46, 0.07)',
  '--shadow-2': '0 1px 2px rgba(21, 31, 46, 0.13), 0 14px 34px rgba(21, 31, 46, 0.14)',
  '--font-sans': `system-ui, ${SYSTEM_SANS}`, '--font-display': '"Fraunces", Georgia, "Times New Roman", serif', '--font-mono': MONO, '--display-weight': '700',
  '--header-height': '64px', '--sidebar-width': '256px',
};

// Rolltop classic dark — design.md §4.3
const rolltopDark: Tokens = {
  ...rolltopLight,
  '--color-bg': 'radial-gradient(circle at 16% -10%, rgba(196, 107, 68, 0.20), transparent 34rem), linear-gradient(180deg, #151f2e 0%, #0e1521 100%)',
  '--color-surface': '#182331', '--color-surface-2': '#202d3b',
  '--color-border': 'rgba(183, 179, 170, 0.24)', '--color-border-strong': 'rgba(183, 179, 170, 0.44)',
  '--color-text': '#f1eee9', '--color-text-strong': '#ffffff', '--color-text-soft': '#cfc8c0', '--color-text-muted': '#b2aaa2',
  '--color-accent': '#c46b44', '--color-accent-strong': '#f0b89d', '--color-accent-soft': 'rgba(196, 107, 68, 0.22)', '--color-accent-contrast': '#151f2e', '--color-accent-warm': '#c46b44',
  '--color-hover': 'rgba(196, 107, 68, 0.18)', '--color-selected': 'rgba(196, 107, 68, 0.25)', '--color-selected-rule': '#c46b44', '--color-checked': 'rgba(196, 107, 68, 0.22)',
  '--color-header-bg': 'rgba(21, 31, 46, 0.94)', '--color-header-text': '#f1eee9', '--color-header-search-bg': 'rgba(255, 255, 255, 0.07)',
  '--color-header-search-text': '#f1eee9', '--color-header-rule': 'rgba(196, 107, 68, 0.60)',
  '--color-sidebar-bg': 'rgba(21, 31, 46, 0.94)', '--color-sidebar-icon': '#b2aaa2', '--color-ink': '#c46b44', '--color-ink-hover': '#d07d58', '--color-ink-text': '#151f2e',
  '--color-critical': '#ff6a6a', '--color-critical-soft': 'rgba(255, 106, 106, 0.18)', '--color-critical-text': '#1a0508',
  '--color-danger': '#e18773', '--color-danger-soft': 'rgba(225, 135, 115, 0.16)', '--color-warning': '#f0b89d', '--color-warning-soft': 'rgba(196, 107, 68, 0.18)',
  '--color-success': '#5ec7a7', '--color-success-soft': 'rgba(94, 199, 167, 0.14)',
  '--color-unread': '#f0b89d', '--color-star': '#e0b64d',
  '--color-note-bg': 'rgba(224, 182, 77, 0.14)', '--color-note-border': 'rgba(224, 182, 77, 0.35)', '--color-note-text': '#f3e7b0',
  '--color-toast-bg': '#f1eee9', '--color-toast-text': '#151f2e', '--color-overlay': 'rgba(5, 9, 15, 0.60)',
  '--color-login-bg': 'linear-gradient(180deg, #151f2e 0%, #0e1521 100%)', '--color-highlight': 'rgba(224, 182, 77, 0.28)',
  '--shadow-1': '0 1px 2px rgba(0, 0, 0, 0.38), 0 14px 34px rgba(0, 0, 0, 0.26)',
  '--shadow-2': '0 1px 2px rgba(0, 0, 0, 0.38), 0 18px 44px rgba(0, 0, 0, 0.36)',
};

// "Simply Seamless": content-first. Slate-navy chrome, soft-stone sidebar, white sheet for the list.
// The structural bits (hover-only row controls, inset dividers, outline nav icons, quick-filter
// pills, framed list) live in app.css under :root[data-theme="simply"].
const simplyLight: Tokens = {
  ...seamlessLight,
  '--color-bg': '#f8fafc', '--color-surface': '#ffffff', '--color-surface-2': '#f8fafc',
  '--color-border': '#e2e8f0', '--color-border-strong': '#cbd5e1',
  '--color-text': '#475569', '--color-text-strong': '#0f172a', '--color-text-soft': '#64748b', '--color-text-muted': '#94a3b8',
  '--color-accent': '#2563eb', '--color-accent-strong': '#1e324e', '--color-accent-soft': '#eff6ff', '--color-accent-warm': '#2563eb',
  '--color-hover': '#f1f5f9', '--color-selected': '#eff6ff', '--color-selected-rule': '#1e324e', '--color-checked': '#eff6ff',
  '--color-header-bg': '#1e324e', '--color-header-search-bg': 'rgba(255, 255, 255, 0.12)',
  '--color-sidebar-bg': '#f8fafc', '--color-sidebar-icon': '#64748b',
  '--color-ink': '#2b4c7e', '--color-ink-hover': '#34598f', '--color-ink-text': '#ffffff',
  '--color-unread': '#2563eb', '--color-focus': '#2563eb',
  '--color-login-bg': 'radial-gradient(circle at 50% 45%, #243b5a 0%, #111e32 100%)',
  '--radius-sm': '6px', '--radius-md': '8px', '--radius-lg': '12px',
  '--shadow-1': '0 1px 2px rgba(15, 23, 42, 0.06), 0 4px 12px rgba(15, 23, 42, 0.06)',
  '--shadow-2': '0 6px 18px rgba(15, 23, 42, 0.16), 0 18px 48px rgba(15, 23, 42, 0.14)',
};

export const THEMES: ThemeDef[] = [
  {
    id: 'seamless', name: 'Seamless', description: 'The original look: navy header, blue accent.',
    tokens: { light: seamlessLight, dark: seamlessDark }, swatch: ['#243959', '#1867c0', '#f4f6f8'],
  },
  {
    id: 'simply', name: 'Simply Seamless', description: 'Content-first: quiet rows, tinted labels, outline icons. Light only.',
    tokens: { light: simplyLight }, swatch: ['#1e324e', '#2563eb', '#f8fafc'],
  },
  {
    id: 'rolltop', name: 'Rolltop', description: 'Warm paper neutrals, terracotta accent, serif titles.',
    tokens: { light: rolltopLight, dark: rolltopDark }, fonts: ['Fraunces'], swatch: ['#151f2e', '#c46b44', '#f2f0eb'],
  },
];

export const DEFAULT_THEME = 'seamless';

export function getTheme(id: string | undefined): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!;
}

/** The mode a theme can actually show: a dark-only theme is always dark. */
export function effectiveMode(theme: ThemeDef, wanted: 'light' | 'dark' | 'system', systemDark: boolean): Mode {
  const want: Mode = wanted === 'system' ? (systemDark ? 'dark' : 'light') : wanted;
  if (theme.tokens[want]) return want;
  return theme.tokens.light ? 'light' : 'dark';
}

export const DENSITY = {
  comfortable: { split: 84, table: 44 },
  compact: { split: 66, table: 34 },
} as const;
