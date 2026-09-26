import { Injectable } from '@nestjs/common';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

// One DOMPurify instance, bound to a headless window — server-side sanitising
// needs a DOM implementation since there is no browser `window` in Node.
const jsdomWindow = new JSDOM('').window;
const purifier = DOMPurify(jsdomWindow as unknown as Window & typeof globalThis);

// Allow-list (decision D-08): headings h2–h4, bold, italic, lists,
// blockquote, links, code, and (C40) GFM tables. Everything else —
// including any raw HTML the author embedded in the Markdown — is stripped.
const ALLOWED_TAGS = [
  'h2', 'h3', 'h4',
  'strong', 'b', 'em', 'i',
  'ul', 'ol', 'li',
  'blockquote',
  'a',
  'code', 'pre',
  'p', 'br',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
];
// `align` is what marked writes on th/td for a `:--`/`--:` column.
const ALLOWED_ATTR = ['href', 'align'];

// C40: the page already owns the h1 (the post or page title), so a `#`
// heading renders as h2 instead of being silently stripped to bare text;
// `#####`/`######` render as h4, the smallest allowed level.
const md = new Marked({ gfm: true });
md.use({
  walkTokens(token) {
    if (token.type === 'heading') token.depth = Math.min(4, Math.max(2, token.depth));
  },
});

purifier.addHook('afterSanitizeAttributes', (node) => {
  // Every surviving link carries rel="noopener noreferrer" (D-08),
  // regardless of what the author wrote or omitted.
  if (node.tagName === 'A') {
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/**
 * Long-form fields hold Markdown, never HTML (12-database.md §1). Rendered
 * and sanitised on read — the client never renders raw HTML from the
 * database, and raw HTML embedded in the Markdown source is stripped here,
 * not merely passed through unrendered.
 */
@Injectable()
export class MarkdownService {
  render(markdown: string | null | undefined): string {
    if (!markdown) return '';
    const rawHtml = md.parse(markdown, { async: false }) as string;
    return purifier.sanitize(rawHtml, { ALLOWED_TAGS, ALLOWED_ATTR });
  }
}
