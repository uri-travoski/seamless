import { getTheme, effectiveMode, type Mode } from './registry.ts';

export interface AppearancePrefs {
  theme: string;                         // registry id
  mode: 'light' | 'dark' | 'system';
  accent: string;                        // '' = the theme's own accent
  density: 'comfortable' | 'compact';
}

const loadedFonts = new Set<string>();

function loadFonts(families: string[]): void {
  for (const f of families) {
    if (loadedFonts.has(f)) continue;
    loadedFonts.add(f);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400;500;600;700&display=swap`;
    document.head.appendChild(link);
  }
}

const systemDark = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;

let current: AppearancePrefs | null = null;
let mql: MediaQueryList | null = null;

/** Apply theme tokens to :root. Instant: CSS variables only, no reload. */
export function applyAppearance(p: AppearancePrefs): Mode {
  current = p;
  const theme = getTheme(p.theme);
  const mode = effectiveMode(theme, p.mode, systemDark());
  const tokens = theme.tokens[mode]!;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);

  if (p.accent && /^#[0-9a-f]{6}$/i.test(p.accent)) {
    const a = p.accent;
    const toward = mode === 'dark' ? 'white' : 'black';
    root.style.setProperty('--color-accent', a);
    root.style.setProperty('--color-accent-warm', a);
    root.style.setProperty('--color-unread', a);
    root.style.setProperty('--color-focus', a);
    root.style.setProperty('--color-accent-soft', `color-mix(in srgb, ${a} ${mode === 'dark' ? 24 : 12}%, var(--color-surface))`);
    root.style.setProperty('--color-accent-strong', `color-mix(in srgb, ${a} 70%, ${toward})`);
    root.style.setProperty('--color-selected', `color-mix(in srgb, ${a} ${mode === 'dark' ? 26 : 16}%, var(--color-surface))`);
  }

  root.dataset.theme = theme.id;
  root.dataset.mode = mode;
  root.dataset.density = p.density;
  root.style.colorScheme = mode;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', tokens['--color-header-bg']?.startsWith('#') ? tokens['--color-header-bg'] : tokens['--color-ink']);
  if (theme.fonts?.length) loadFonts(theme.fonts);

  // follow the OS while "system" is chosen
  if (typeof matchMedia === 'function') {
    mql ??= matchMedia('(prefers-color-scheme: dark)');
    mql.onchange = () => { if (current?.mode === 'system') applyAppearance(current); };
  }
  return mode;
}
