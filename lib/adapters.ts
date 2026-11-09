import type { SiteId } from './settings';

/** One adapter per site: where posts are, and which element holds the post's own text.
 *  Selectors target stable test ids / custom elements where sites expose them. */
export interface Adapter {
  id: SiteId;
  hosts: RegExp;
  post: string;
  text(post: Element): HTMLElement | null;
}

const q = (sel: string) => (post: Element) => post.querySelector<HTMLElement>(sel);

export const ADAPTERS: Adapter[] = [
  {
    id: 'x',
    hosts: /(^|\.)(x|twitter)\.com$/,
    post: 'article[data-testid="tweet"]',
    text: q('[data-testid="tweetText"]'),
  },
  {
    id: 'reddit',
    hosts: /(^|\.)reddit\.com$/,
    // new Reddit (shreddit web components) + old.reddit
    post: 'shreddit-post, shreddit-comment, .thing.link, .thing.comment',
    text: (p) =>
      p.querySelector<HTMLElement>(
        ':scope > [slot="text-body"], :scope > [slot="comment"], :scope > .entry .usertext-body .md',
      ),
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
  },
  {
    id: 'demo',
    hosts: /^(localhost|127\.0\.0\.1)$/,
    post: '[data-slopless-demo-post]',
    text: q('.demo-text'),
  },
];

export const adapterFor = (host: string) => ADAPTERS.find((a) => a.hosts.test(host));
