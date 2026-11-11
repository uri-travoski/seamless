import { create } from 'zustand';

/** App-level dialogs that can be opened from anywhere (settings nav, keyboard). */
export const useUi = create<{ helpOpen: boolean; shortcutsOpen: boolean; set: (p: Partial<{ helpOpen: boolean; shortcutsOpen: boolean }>) => void }>((set) => ({
  helpOpen: false,
  shortcutsOpen: false,
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
