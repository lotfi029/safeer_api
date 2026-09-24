const VAR_PATTERN = /\{\{\s*(\w+)\s*\}\}/g;

/** Every `{{var}}` token used in a piece of template text, in appearance order (duplicates included). */
export function extractVariables(text: string): string[] {
  return [...text.matchAll(VAR_PATTERN)].map((m) => m[1]);
}

/**
 * M2/finding C: CommonMark's ASCII-punctuation backslash-escape set,
 * restricted to the characters that can actually change Markdown structure
 * inline — `\ [ ] ( ) \` * _ < > ! { }`. Deliberately excludes `. - # +`:
 * those only carry special meaning in *leading* position (a numbered list,
 * a bullet, a heading, a leading `+` list marker), never mid-string, so a
 * real URL substituted into a link target — `[{{link}}]({{link}})`, every
 * one of `contact_notify`/`user_invite`/`password_reset`'s seeded bodies —
 * still passes through byte-for-byte where it matters. A CommonMark parser
 * honours a backslash escape inside a link destination the same as
 * anywhere else, so an escaped character here still renders as its literal
 * form in the final HTML; it is only prevented from being *parsed* as
 * Markdown syntax.
 */
const MARKDOWN_METACHARS = /[\\[\]()`*_<>!{}]/g;

function escapeMarkdown(value: string): string {
  return value.replace(MARKDOWN_METACHARS, '\\$&');
}

/**
 * M2/finding C: substitutes `{{var}}` into the Markdown **source**, before
 * `MarkdownService.render()` (which runs DOMPurify) ever sees it — the
 * previous order rendered first and substituted into the already-sanitised
 * HTML, so DOMPurify never inspected a single attacker- or user-influenced
 * byte. Escaping Markdown metacharacters in the *value* (never the
 * template source, which an admin already controls and which is exactly
 * where the intended `[text](url)` syntax lives) stops a value containing
 * `[` or `(` from injecting new Markdown structure — e.g. a contact
 * submission's `fullName` closing out of an unrelated link and opening its
 * own.
 *
 * This also happens to be what makes `[{{link}}]({{link}})` (the shape all
 * three of `contact_notify`/`user_invite`/`password_reset` actually use)
 * work at all: substituting after rendering had `marked` percent-encode
 * the *literal token* `{{link}}` inside the href, so the rendered anchor's
 * `href` was permanently `%7B%7Blink%7D%7D` regardless of what
 * substitution did afterward — the HTML part of every invite and
 * password-reset email had a dead link, while its plain-text alternative
 * (rendered from the unescaped source via `substitutePlain`) was fine.
 * Substituting first means `marked` sees and encodes the real URL.
 */
export function substituteMarkdown(markdown: string, vars: Record<string, string>): string {
  return markdown.replace(VAR_PATTERN, (_, name: string) => escapeMarkdown(vars[name] ?? ''));
}

/**
 * Same substitution over the raw Markdown source, unescaped — the
 * plain-text alternative (FR-E-05). A variable missing from `vars` at send
 * time becomes an empty string rather than throwing — a template's
 * `variables` allow-list is validated at save time (UNKNOWN_VARIABLE); a
 * gap between what a template expects and what a specific call site passed
 * is a caller bug that must not break mail delivery for everyone else
 * (trap 13), so it degrades instead of failing.
 */
export function substitutePlain(markdown: string, vars: Record<string, string>): string {
  return markdown.replace(VAR_PATTERN, (_, name: string) => vars[name] ?? '');
}
