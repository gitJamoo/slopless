import { browser } from 'wxt/browser';
import type { DailyStats, Settings } from './settings';
import type { Verdict } from './text';

export interface Score {
  score: number;
  verdict: Verdict;
  label: string;
  ms: number;
  cached?: boolean;
  /** Class probabilities from the model, e.g. [human, ai] or [human, ai-edited, ai]. */
  probs?: number[];
}

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

export interface EngineStatus {
  loaded: boolean;
  modelPresent: boolean;
  /** Benchmark-only stand-in (untrained head): verdicts are meaningless. */
  standIn?: boolean;
  modelName?: string;
  modelMB?: number;
  loadMs?: number;
  avgMs?: number;
  runs: number;
  threads?: number;
  error?: string;
}

export type BgRequest =
  | { type: 'score'; text: string }
  | { type: 'status' }
  | { type: 'test'; text: string }
  | { type: 'benchmark'; runs: number; words: number };

export type EngineRequest =
  | { target: 'engine'; type: 'detect'; texts: string[]; maxTokens: number }
  | { target: 'engine'; type: 'status' }
  | { target: 'engine'; type: 'benchmark'; runs: number; words: number; maxTokens: number };

/** Sent by the engine itself when it has been idle long enough to be shut down. */
export interface EngineIdle {
  type: 'engine-idle';
}

export interface StatusResponse {
  settings: Settings;
  stats: DailyStats;
  engine: EngineStatus;
}

export interface BenchResponse {
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

export function send<T = any>(msg: BgRequest | EngineRequest | EngineIdle): Promise<T> {
  return browser.runtime.sendMessage(msg) as Promise<T>;
}
