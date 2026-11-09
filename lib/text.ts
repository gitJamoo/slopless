// Pure text helpers. No browser APIs here, so they run under `node --test` too.

/**
 * The ONE normalization applied to text before the model sees it, in the browser and in
 * training alike. The Python twin (training/slopdata/normalize.py) must produce identical
 * output for every case in training/normalize_cases.json, and tests check both sides.
 * Placeholders remove cues that differ by data source rather than by author (links, handles).
 * Case and emoji are kept: they're real style signal.
 */
export function normalizeForModel(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, '<url>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/(^|[^\w@])@\w{1,30}/g, '$1@user')
    .replace(/\s+/g, ' ')
    .trim();
}

export function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0;
}

/** Visible post text → clean string: drop "Show more" chrome, tidy whitespace. */
export function normalizePostText(text: string): string {
  return text
    .replace(/ /g, ' ')
    .replace(/(…|\.\.\.)?\s*(Show more|See more|Read more)\s*$/i, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Softmax, then score = expected class index / (n-1). For 2 classes that's just P(ai). */
export function bucketScore(logits: number[]): { score: number; probs: number[] } {
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  const probs = exps.map((e) => e / sum);
  const score = probs.reduce((acc, p, i) => acc + p * i, 0) / (probs.length - 1);
  return { score, probs };
}

export type Verdict = 'human' | 'unsure' | 'ai';

export function verdictFor(score: number, threshold: number): Verdict {
  if (score >= threshold) return 'ai';
  if (score >= threshold * 0.75) return 'unsure';
  return 'human';
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  ai: 'Likely AI',
  unsure: 'Possibly AI',
  human: 'Likely human',
};

/** Account-level evidence: many short posts add up even when each alone is too short to judge. */
export function accountVerdict(scores: number[], threshold: number, minPosts = 5) {
  if (scores.length < minPosts) return null;
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const aiShare = scores.filter((s) => s >= threshold).length / scores.length;
  return mean >= threshold || aiShare >= 0.6 ? { n: scores.length, mean, aiShare } : null;
}
