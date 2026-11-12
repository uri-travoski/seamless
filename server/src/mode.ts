/** Live mode vs Viewing mode (T8.7). In Viewing mode mail is neither received nor sent; everything else works.
 *  The server enforces this; the UI only explains it. `SEAMLESS_MODE` overrides the stored setting and locks the switch. */
import { getSetting, setSetting } from './db.ts';

export type AppMode = 'live' | 'viewing';
const KEY = 'app_mode';

export class ViewingModeError extends Error {
  statusCode = 409;
  code = 'viewing_mode';
  constructor(what: string) { super(`Viewing mode: ${what} is turned off`); this.name = 'ViewingModeError'; }
}

let stored: AppMode = 'live';

function envMode(): AppMode | null {
  const v = (process.env.SEAMLESS_MODE ?? '').trim().toLowerCase();
  return v === 'viewing' || v === 'live' ? v : null;
}

/** Read the stored setting into memory (boot, and after a restore or a test reset). */
export async function loadMode(): Promise<AppMode> {
  stored = (await getSetting(KEY)) === 'viewing' ? 'viewing' : 'live';
  return currentMode();
}

export function currentMode(): AppMode { return envMode() ?? stored; }
export function modeLocked(): boolean { return envMode() !== null; }
export function isViewing(): boolean { return currentMode() === 'viewing'; }

/** Throws ViewingModeError (HTTP 409) when the instance is in Viewing mode. */
export function assertLive(what: string): void {
  if (isViewing()) throw new ViewingModeError(what);
}

export async function setStoredMode(mode: AppMode): Promise<void> {
  await setSetting(KEY, mode);
  stored = mode;
}

export function viewingBody(err: ViewingModeError): { error: 'viewing_mode'; message: string } {
  return { error: 'viewing_mode', message: err.message };
}
