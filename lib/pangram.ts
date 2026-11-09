// Pangram REST API client (docs.pangram.com, Pangram 4).
// Submit -> poll. Your key goes straight from this device to Pangram; nothing else sees it.

const BASE = 'https://text.external-api.pangram.com';
export const PANGRAM_MODEL = 'pangram-4';

interface TaskResult {
  stage: 'STAGE_SUCCESS' | 'STAGE_FAILED' | string;
  headline?: string;
  prediction_short?: string;
  fraction_ai?: number;
  fraction_ai_assisted?: number;
  fraction_human?: number;
}

export interface PangramScore {
  score: number;
  label: string;
}

async function call(path: string, key: string, init: RequestInit = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, ...(init.headers ?? {}) },
  });
  if (res.status === 401 || res.status === 403) throw new Error('Pangram rejected the API key');
  if (res.status === 429) throw new Error('Pangram rate limit hit');
  if (!res.ok) throw new Error(`Pangram HTTP ${res.status}`);
  return res.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function pangramDetect(text: string, key: string, timeoutMs = 30_000): Promise<PangramScore> {
  const { task_id } = await call('/task', key, {
    method: 'POST',
    body: JSON.stringify({ text, model: PANGRAM_MODEL, public_dashboard_link: false }),
  });
  const deadline = Date.now() + timeoutMs;
  let wait = 250;
  while (Date.now() < deadline) {
    await sleep(wait);
    wait = Math.min(wait * 1.5, 1500);
    const r: TaskResult = await call(`/task/${task_id}`, key);
    if (r.stage === 'STAGE_SUCCESS') {
      // One number for the UI: fully-AI text counts fully, AI-assisted text counts half.
      const score = (r.fraction_ai ?? 0) + 0.5 * (r.fraction_ai_assisted ?? 0);
      return { score: Math.min(1, score), label: r.prediction_short || r.headline || 'Scored' };
    }
    if (r.stage === 'STAGE_FAILED') throw new Error(r.headline || 'Pangram could not score this text');
  }
  throw new Error('Pangram timed out');
}
