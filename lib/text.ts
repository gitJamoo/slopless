// Pure text helpers. No browser APIs here, so they run under `node --test` too.

const BOILERPLATE_STARTS = ['Sure', 'Here', 'Abstract', 'Title', "I'm happy to help", 'Certainly'];
const EMOJI = /\p{Extended_Pictographic}(‍\p{Extended_Pictographic}|️)*/gu;

/** Mirrors EditLens `clean_text` (scripts/preprocess.py) so the on-device model
 *  sees text the way it was trained. One deviation: Python demojizes to ":name:";
 *  we drop emoji instead (no 500KB emoji table in a slim extension). */
export function cleanForModel(raw: string): string {
  let text = raw.replace(EMOJI, ' ');
  if (text.includes('</think>')) text = (text.split('</think>')[1] ?? '').trim();
  const paragraphs = text.split('\n').filter((p) => p.trim());
  if (paragraphs.length > 1) {
    const first = paragraphs[0]!.replace(/^[^a-zA-Z0-9]*/, '');
    if (BOILERPLATE_STARTS.some((b) => first.startsWith(b))) text = paragraphs.slice(1).join('\n');
  }
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0;
}

/** Normalise visible post text: collapse whitespace, drop "Show more" style chrome. */
export function normalizePostText(text: string): string {
  return text
    .replace(/ /g, ' ')
    .replace(/(…|\.\.\.)?\s*(Show more|See more|Read more|more)\s*$/i, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function hashText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Pangram 4 bills per started 100-word block, $0.05 each, minimum one block. */
export function pangramCostUsd(words: number): number {
  return Math.max(1, Math.ceil(words / 100)) * 0.05;
}

/** EditLens score: expected bucket index, normalised to [0, 1]. */
export function bucketScore(logits: number[]): { score: number; probs: number[] } {
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  const probs = exps.map((e) => e / sum);
  const n = probs.length;
  const score = probs.reduce((acc, p, i) => acc + p * i, 0) / (n - 1);
  return { score, probs };
}

export type Verdict = 'human' | 'edited' | 'ai';

export function verdictFor(score: number, threshold: number): Verdict {
  if (score >= threshold) return 'ai';
  if (score >= threshold * 0.6) return 'edited';
  return 'human';
}
