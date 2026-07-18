import { slugify } from "@/shared/slug";

export { slugify };

const WIKI_LINK_PATTERN = /\[\[([^\]]+)\]\]/g;
const NOTE_ID_PREFIX = "note:";

/** The deterministic node id for a slug, e.g. `note:graph-databases`. */
export function noteId(slug: string): string {
  return `${NOTE_ID_PREFIX}${slug}`;
}

/**
 * Resolves a user-supplied reference — a full id, a slug, or a title — to a
 * note id, so the same endpoint accepts `graph-databases`, `Graph Databases`,
 * or `note:graph-databases`. Returns `undefined` when the reference has no
 * addressable slug (empty, or non-alphanumeric like "!!!"), so callers treat
 * it as not-found rather than resolving to the bare `note:` prefix.
 */
export function resolveNoteId(reference: string): string | undefined {
  const id = reference.startsWith(NOTE_ID_PREFIX)
    ? reference
    : noteId(slugify(reference));
  return id === NOTE_ID_PREFIX ? undefined : id;
}

/**
 * Extracts the distinct `[[Target Title]]` link targets from a note body,
 * preserving first-seen order. Returns the raw titles; slugging is the
 * caller's job so it can also create the target notes.
 */
export function parseWikiLinks(body: string): readonly string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(WIKI_LINK_PATTERN)) {
    const title = match[1]?.trim();
    if (title !== undefined && title !== "") seen.add(title);
  }
  return [...seen];
}
