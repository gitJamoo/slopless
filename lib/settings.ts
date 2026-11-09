import { browser } from 'wxt/browser';

export type Mode = 'off' | 'flag' | 'hide' | 'rewrite';
export type Detector = 'local' | 'pangram' | 'hybrid';
export type RewriteEngine = 'builtin' | 'openai';
export type SiteId = 'x' | 'reddit' | 'linkedin' | 'bluesky' | 'demo';

export interface Settings {
  mode: Mode;
  detector: Detector;
  /** Score at or above this counts as AI (0–1). */
  threshold: number;
  /** Posts shorter than this are never scored: detectors are unreliable on short text. */
  minWords: number;
  /** Token cap for the on-device model. 512 is what it was trained on; 256 is ~2x faster. */
  maxTokens: number;
  blurWhileChecking: boolean;
  sites: Record<SiteId, boolean>;
  pangramKey: string;
  dailyBudgetUsd: number;
  /** Hybrid: only escalate to Pangram when the local score is in this band. */
  hybridLow: number;
  hybridHigh: number;
  rewriteEngine: RewriteEngine;
  openaiBaseUrl: string;
  openaiModel: string;
  openaiKey: string;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'flag',
  detector: 'local',
  threshold: 0.7,
  minWords: 40,
  maxTokens: 256,
  blurWhileChecking: true,
  sites: { x: true, reddit: true, linkedin: true, bluesky: true, demo: true },
  pangramKey: '',
  dailyBudgetUsd: 1,
  hybridLow: 0.35,
  hybridHigh: 0.85,
  rewriteEngine: 'builtin',
  openaiBaseUrl: 'http://localhost:11434/v1',
  openaiModel: 'llama3.2',
  openaiKey: '',
};

// storage.local (never .sync): keys and settings stay on this device.
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
  local: number;
  localMs: number;
  pangramCalls: number;
  pangramUsd: number;
}

export const today = () => new Date().toISOString().slice(0, 10);
export const emptyStats = (): DailyStats => ({
  date: today(), scanned: 0, flagged: 0, local: 0, localMs: 0, pangramCalls: 0, pangramUsd: 0,
});
