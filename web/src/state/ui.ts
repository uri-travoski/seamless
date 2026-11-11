import { create } from 'zustand';

/** App-level dialogs that can be opened from anywhere (settings nav, keyboard). */
interface UiState {
  helpOpen: boolean;
  shortcutsOpen: boolean;
  /** Snooze picker anchored at a screen point for one message (row clock icon, keyboard b). */
  snoozeFor: { id: string; x: number; y: number } | null;
  set: (p: Partial<Omit<UiState, 'set'>>) => void;
}
export const useUi = create<UiState>((set) => ({
  helpOpen: false,
  shortcutsOpen: false,
  snoozeFor: null,
  set: (p) => set(p),
}));

/**
 * Spread on search/filter boxes so password managers (Bitwarden, 1Password, LastPass,
 * Dashlane) don't treat them as a login field and pop their autofill menu over them.
 */
export const NO_AUTOFILL = {
  autoComplete: 'off',
  spellCheck: false,
  'data-bwignore': 'true',
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-form-type': 'other',
} as const;
