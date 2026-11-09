import { browser } from 'wxt/browser';

export type Mode = 'off' | 'flag' | 'hide';
export type SiteId = 'x' | 'reddit' | 'linkedin' | 'bluesky' | 'demo';

export interface Settings {
  mode: Mode;
  /** Score at or above this counts as AI (0–1). Tuned for ≤1% false positives on human posts. */
  threshold: number;
  /** Posts shorter than this get no badge of their own (they still count toward an account's verdict). */
  minWords: number;
  /** Token cap for the model. X posts are short; 128 covers ~95 words. */
  maxTokens: number;
  blurWhileChecking: boolean;
  /** Flag accounts whose recent posts are mostly AI, even if each post is too short to judge. */
  accountVerdicts: boolean;
  sites: Record<SiteId, boolean>;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'flag',
  threshold: 0.7,
  minWords: 15,
  maxTokens: 128,
  blurWhileChecking: true,
  accountVerdicts: true,
  // The model is trained for X first; other sites are experimental until it's trained on them.
  sites: { x: true, reddit: false, linkedin: false, bluesky: false, demo: true },
};

// storage.local (never .sync): settings stay on this device.
export async function getSettings(): Promise<Settings> {
  const { settings } = await browser.storage.local.get('settings');
  const stored = (settings ?? {}) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...stored, sites: { ...DEFAULT_SETTINGS.sites, ...stored.sites } };
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await browser.storage.local.set({ settings: next });
  return next;
}

export function onSettingsChanged(cb: (s: Settings) => void) {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) getSettings().then(cb);
  });
}

export interface DailyStats {
  date: string;
  scanned: number;
  flagged: number;
  modelMs: number;
}

export const today = () => new Date().toISOString().slice(0, 10);
export const emptyStats = (): DailyStats => ({ date: today(), scanned: 0, flagged: 0, modelMs: 0 });
