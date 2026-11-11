/** Settings → Appearance (T0 F-05): theme, light/dark/system, density, accent colour, font. */
import { THEMES } from '../../theme/registry.ts';
import { useSession } from '../../state/session.ts';
import { SunIcon, MoonIcon, SystemIcon, CheckIcon } from '../../icons.tsx';

const ACCENTS = ['#1867c0', '#a85d24', '#c46b44', '#17795f', '#7a5fd0', '#d05f8e', '#0f766e', '#b91c1c'];

const POPULAR_FONTS = [
  'Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Nunito', 'Nunito Sans',
  'Work Sans', 'Source Sans 3', 'IBM Plex Sans', 'DM Sans', 'Manrope', 'Plus Jakarta Sans', 'Rubik', 'Karla',
  'Merriweather', 'Lora', 'Playfair Display', 'PT Serif', 'Roboto Slab',
  'JetBrains Mono', 'Roboto Mono', 'IBM Plex Mono', 'Space Grotesk', 'Figtree',
];

export default function AppearanceSettings() {
  const s = useSession((x) => x.settings);
  const save = useSession((x) => x.saveSettings);

  return (
    <div>
      <h2>Appearance</h2>
      <p className="settings-desc">Changes apply instantly and follow you to every device you sign in on.</p>

      <h3>Theme</h3>
      <div className="theme-cards">
        {THEMES.map((t) => (
          <button key={t.id} className={`theme-card ${s.theme === t.id ? 'on' : ''}`} onClick={() => save({ theme: t.id })} aria-pressed={s.theme === t.id}>
            <span className="theme-swatch">
              {t.swatch.map((c, i) => <span key={i} style={{ background: c }} />)}
            </span>
            <span className="theme-name">{t.name}{s.theme === t.id && <CheckIcon size={14} weight="bold" />}</span>
            <span className="theme-desc">{t.description}</span>
          </button>
        ))}
      </div>

      <h3>Mode</h3>
      <div className="seg" role="group" aria-label="Colour mode">
        {([['light', 'Light', SunIcon], ['dark', 'Dark', MoonIcon], ['system', 'Match system', SystemIcon]] as const).map(([v, label, Icon]) => (
          <button key={v} className={`seg-btn ${s.mode === v ? 'on' : ''}`} onClick={() => save({ mode: v })}><Icon size={15} /> {label}</button>
        ))}
      </div>
      {THEMES.find((t) => t.id === s.theme)?.tokens.light === undefined && <p className="hint">This theme only comes in dark.</p>}

      <h3>Accent colour</h3>
      <div className="swatches">
        <button className={`swatch theme-default ${!s.accent ? 'on' : ''}`} onClick={() => save({ accent: '' })} title="The theme's own accent">A</button>
        {ACCENTS.map((c) => <button key={c} className={`swatch ${s.accent === c ? 'on' : ''}`} style={{ background: c }} onClick={() => save({ accent: c })} aria-label={c} />)}
        <input type="color" value={s.accent || '#1867c0'} onChange={(e) => save({ accent: e.target.value })} aria-label="Custom accent" />
      </div>

      <h3>Density</h3>
      <div className="seg" role="group" aria-label="Density">
        {(['comfortable', 'compact'] as const).map((d) => (
          <button key={d} className={`seg-btn ${s.density === d ? 'on' : ''}`} onClick={() => save({ density: d })}>{d[0].toUpperCase() + d.slice(1)}</button>
        ))}
      </div>

      <h3>Layout</h3>
      <p className="settings-desc">Split shows the list beside a reading pane. Table is a full-width list; clicking a row opens the message.</p>
      <div className="seg" role="group" aria-label="Layout">
        <button className={`seg-btn ${s.layout === 'split' ? 'on' : ''}`} onClick={() => save({ layout: 'split' })}>Split view</button>
        <button className={`seg-btn ${s.layout === 'table' ? 'on' : ''}`} onClick={() => save({ layout: 'table' })}>Table view</button>
      </div>

      <h3>Font</h3>
      <p className="settings-desc">Any Google font by name, applied across the app. Leave empty for the default, Inter.</p>
      <div className="field-row" style={{ alignItems: 'flex-end' }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <input className="text-input" list="google-fonts" value={s.fontFamily} placeholder="Inter (default) — or Roboto, Lato…"
            onChange={(e) => save({ fontFamily: e.target.value })} aria-label="Google font" />
          <datalist id="google-fonts">{POPULAR_FONTS.map((f) => <option key={f} value={f} />)}</datalist>
        </div>
        {s.fontFamily && s.fontFamily !== 'Inter' && <button className="btn" onClick={() => save({ fontFamily: 'Inter' })}>Reset</button>}
      </div>
      <h3>Text size</h3>
      <div className="range-line">
        <input type="range" min={12} max={20} step={1} value={s.fontSize} onChange={(e) => save({ fontSize: Number(e.target.value) })} aria-label="Text size" />
        <output>{s.fontSize}px</output>
      </div>
      <div className="font-preview">The quick brown fox jumps over the lazy dog — {s.fontFamily || 'Inter'} at {s.fontSize}px.</div>
    </div>
  );
}
