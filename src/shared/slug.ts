const NON_SLUG_CHARS = /[^a-z0-9]+/g;
const EDGE_HYPHENS = /^-+|-+$/g;

/**
 * Turns free text into a stable, url-safe slug. Idempotent: feeding an
 * existing slug back in returns it unchanged, so titles/names and slugs
 * resolve to the same deterministic node id.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(NON_SLUG_CHARS, "-")
    .replace(EDGE_HYPHENS, "");
}
