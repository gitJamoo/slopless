import { browser } from 'wxt/browser';
import type { Verdict } from './text';
import type { DailyStats, Settings } from './settings';

export type Source = 'local' | 'pangram';

export interface Score {
  score: number;
  verdict: Verdict;
  source: Source;
  /** Short human label, e.g. "AI-generated" or Pangram's prediction_short. */
  label: string;
  ms: number;
  cached?: boolean;
  /** Local model bucket probabilities (human, light edit, heavy edit, AI). */
  probs?: number[];
}

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

export interface EngineStatus {
  loaded: boolean;
  modelPresent: boolean;
  /** Benchmark-only stand-in (untrained head): scores are meaningless. */
  standIn?: boolean;
  device?: string;
  dtype?: string;
  loadMs?: number;
  avgMs?: number;
  runs: number;
  crossOriginIsolated: boolean;
  threads?: number;
  error?: string;
}

export type BgRequest =
  | { type: 'score'; text: string }
  | { type: 'rewrite'; text: string }
  | { type: 'status' }
  | { type: 'test'; text: string }
  | { type: 'benchmark'; runs: number; words: number };

export type EngineRequest =
  | { target: 'engine'; type: 'detect'; texts: string[]; maxTokens: number }
  | { target: 'engine'; type: 'rewrite'; text: string }
  | { target: 'engine'; type: 'status' }
  | { target: 'engine'; type: 'benchmark'; runs: number; words: number; maxTokens: number };

export interface StatusResponse {
  settings: Settings;
  stats: DailyStats;
  engine: EngineStatus;
}

export interface BenchResponse {
  device: string;
  dtype: string;
  loadMs: number;
  tokens: number;
  runs: number;
  medianMs: number;
  p90Ms: number;
  batch8PerPostMs: number;
}

/** Callback-style messaging: works in Chrome, Firefox and Safari alike. */
export function listen(handler: (msg: any) => Promise<unknown> | undefined) {
  browser.runtime.onMessage.addListener((msg: any, _sender: any, sendResponse: (r: unknown) => void) => {
    const p = handler(msg);
    if (!p) return false;
    p.then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
    return true;
  });
}

export function send<T = any>(msg: BgRequest | EngineRequest): Promise<T> {
  return browser.runtime.sendMessage(msg) as Promise<T>;
}
