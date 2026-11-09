import type { SiteId } from './settings';

/**
 * One adapter per site: where posts are, which element holds the post's own text, and
 * (optionally) who wrote it. Prefer stable hooks (data-testid, custom elements) over classes.
 * Adding a site = adding an entry here + a `matches` pattern in entrypoints/content.
 */
export interface Adapter {
  id: SiteId;
  hosts: RegExp;
  post: string;
  text(post: Element): HTMLElement | null;
  /** Stable author id (e.g. handle) for account-level verdicts. */
  author?(post: Element): string | null;
}

const q = (sel: string) => (post: Element) => post.querySelector<HTMLElement>(sel);

export const ADAPTERS: Adapter[] = [
  {
    id: 'x',
    hosts: /(^|\.)(x|twitter)\.com$/,
    post: 'article[data-testid="tweet"]',
    text: q('[data-testid="tweetText"]'),
    author: (p) => {
      const href = p.querySelector<HTMLAnchorElement>('[data-testid="User-Name"] a[href^="/"]')?.getAttribute('href');
      return href ? href.split('/')[1]?.toLowerCase() || null : null;
    },
  },
  {
    id: 'reddit',
    hosts: /(^|\.)reddit\.com$/,
    post: 'shreddit-post, shreddit-comment, .thing.link, .thing.comment',
    text: (p) =>
      p.querySelector<HTMLElement>(
        ':scope > [slot="text-body"], :scope > [slot="comment"], :scope > .entry .usertext-body .md',
      ),
    author: (p) => p.getAttribute('author') ?? p.getAttribute('data-author'),
  },
  {
    id: 'linkedin',
    hosts: /(^|\.)linkedin\.com$/,
    post: 'div.feed-shared-update-v2, [data-urn^="urn:li:activity"]',
    text: q('.update-components-text, .feed-shared-inline-show-more-text, .feed-shared-text'),
  },
  {
    id: 'bluesky',
    hosts: /(^|\.)bsky\.app$/,
    post: '[data-testid^="feedItem-"], [data-testid^="postThreadItem-"]',
    text: q('[data-testid="postText"]'),
    author: (p) => p.querySelector('a[href^="/profile/"]')?.getAttribute('href')?.split('/')[2] ?? null,
  },
  {
    id: 'demo',
    hosts: /^(localhost|127\.0\.0\.1)$/,
    post: '[data-slopless-demo-post]',
    text: q('.demo-text'),
    author: (p) => p.querySelector('.handle')?.textContent ?? null,
  },
];

export const adapterFor = (host: string) => ADAPTERS.find((a) => a.hosts.test(host));
