import { asEdgeId, asNodeId } from "@nicia-ai/typegraph";

import type { AiRunner } from "@/shared/ai";

import { EMBEDDING_DIMENSIONS, type Note, type NotesStore } from "./graph";
import { noteId, parseWikiLinks, resolveNoteId, slugify } from "./wiki-links";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const NOTE_KIND = "Note";
const LINK_EDGE_KIND = "linksTo";
const LINK_EDGES = [LINK_EDGE_KIND] as const;
const MAX_PATH_HOPS = 12;
const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_SEMANTIC_LIMIT = 5;

/** Rejection when a title has no addressable slug (empty, or "!!!"). */
const EMPTY_SLUG_MESSAGE = "title must contain at least one letter or number";

/** Body given to a note that only exists because something linked to it. */
const PLACEHOLDER_BODY =
  "This note was created automatically from a wiki-link and has no content yet.";

/** Deterministic edge id so re-runs and concurrent writes converge, not duplicate. */
function linkEdgeId(fromId: string, toId: string): string {
  return `${LINK_EDGE_KIND}:${fromId}->${toId}`;
}

export type WriteResult = Readonly<{
  id: string;
  created: boolean;
  linksTo: readonly string[];
}>;

/**
 * A write either succeeds with the note's outcome or is rejected with a
 * human-readable reason the route turns into a 400.
 */
export type WriteOutcome =
  | Readonly<{ ok: true; result: WriteResult }>
  | Readonly<{ ok: false; error: string }>;

export type SearchHit = Readonly<{
  id: string;
  title: string;
  score: number;
  rank: number;
  snippet: string;
}>;

export type Backlink = Readonly<{ id: string; title: string }>;

export type PathResult = Readonly<{
  found: boolean;
  depth: number;
  pathNodeIds: readonly string[];
}>;

export type SemanticHit = Readonly<{
  id: string;
  title: string;
  score: number;
}>;

/**
 * The note-graph domain operations, closed over one tenant's store and the
 * optional AI binding. Routing (index.ts) and seeding (seed.ts) both drive the
 * graph exclusively through here, so wiki-link parsing and edge sync stay in
 * one place.
 */
export function createNotesOperations(store: NotesStore, ai?: AiRunner) {
  /**
   * Creates or updates a note by its slug and re-derives its outgoing links
   * from the current body: missing targets are created as placeholders
   * (Obsidian-style), stale `linksTo` edges are removed, and current ones are
   * created. The forward links are the only edges stored — backlinks come from
   * traversing them inversely.
   */
  async function writeNote(title: string, body: string): Promise<WriteOutcome> {
    const slug = slugify(title);
    // An empty slug would collapse every such title onto the id "note:" and
    // silently overwrite whatever note lived there — reject it instead.
    if (slug === "") return { ok: false, error: EMPTY_SLUG_MESSAGE };
    const id = noteId(slug);

    const existing = await store.nodes.Note.getById(asNodeId<typeof Note>(id));
    const embeddingVector = await embed(`${title}\n\n${body}`);
    await store.nodes.Note.upsertById(
      id,
      embeddingVector === undefined
        ? { slug, title, body }
        : { slug, title, body, embedding: embeddingVector },
    );

    const targetIds = await ensureLinkTargets(id, parseWikiLinks(body));
    await syncOutgoingLinks(id, targetIds);

    return {
      ok: true,
      result: { id, created: existing === undefined, linksTo: targetIds },
    };
  }

  /**
   * Ensures every wiki-link target exists, creating absent ones as
   * placeholders. Returns the distinct target ids, excluding self-links.
   */
  async function ensureLinkTargets(
    sourceId: string,
    targetTitles: readonly string[],
  ): Promise<readonly string[]> {
    const targetIds: string[] = [];
    for (const targetTitle of targetTitles) {
      const targetSlug = slugify(targetTitle);
      // A link like [[!!!]] has no addressable target — ignore it entirely
      // (no placeholder, no edge) rather than point at the bare "note:" id.
      if (targetSlug === "") continue;
      const targetId = noteId(targetSlug);
      if (targetId === sourceId || targetIds.includes(targetId)) continue;
      targetIds.push(targetId);

      const target = await store.nodes.Note.getById(
        asNodeId<typeof Note>(targetId),
      );
      if (target === undefined) {
        await store.nodes.Note.create(
          { slug: targetSlug, title: targetTitle, body: PLACEHOLDER_BODY },
          { id: targetId },
        );
      }
    }
    return targetIds;
  }

  /** Deletes links no longer in the body and creates newly added ones. */
  async function syncOutgoingLinks(
    sourceId: string,
    desiredTargetIds: readonly string[],
  ): Promise<void> {
    const source = { kind: NOTE_KIND, id: sourceId } as const;
    const current = await store.edges.linksTo.findFrom(source);

    const desired = new Set(desiredTargetIds);
    const currentTargets = new Set(current.map((edge) => String(edge.toId)));

    for (const edge of current) {
      if (!desired.has(String(edge.toId))) {
        await store.edges.linksTo.delete(edge.id);
      }
    }
    for (const targetId of desiredTargetIds) {
      if (!currentTargets.has(targetId)) {
        await createLink(source, targetId);
      }
    }
  }

  /**
   * Creates one forward link with a deterministic id, tolerant of a
   * concurrent write that already created the same edge: the id collides, so
   * the duplicate attempt converges instead of adding a parallel A→B edge.
   */
  async function createLink(
    source: Readonly<{ kind: typeof NOTE_KIND; id: string }>,
    targetId: string,
  ): Promise<void> {
    const id = linkEdgeId(source.id, targetId);
    try {
      await store.edges.linksTo.create(
        source,
        { kind: NOTE_KIND, id: targetId },
        {},
        { id },
      );
    } catch (error) {
      const existing = await store.edges.linksTo.getById(asEdgeId(id));
      if (existing === undefined) throw error;
    }
  }

  /**
   * FTS5 full-text search over title and body, best match first.
   *
   * The raw BM25 magnitude is a poor number to show a human: it is dominated
   * by inverse document frequency, so a term that appears in most notes
   * (search "graph" in a graph-database garden) scores ~1e-6 across the board
   * and renders as 0.00, even though the ranking is still correct. We surface
   * relevance relative to the top hit instead — the best match is always 1.0
   * and the rest scale proportionally, preserving real spread for
   * discriminating terms while never collapsing to zero. `rank` carries the
   * raw 1-based ordinal for callers that want it. When even the top score is
   * non-positive (a term present in every note), we fall back to rank order.
   */
  async function searchNotes(
    query: string,
    limit = DEFAULT_SEARCH_LIMIT,
  ): Promise<readonly SearchHit[]> {
    const results = await store.search.fulltext(NOTE_KIND, {
      query,
      limit,
      includeSnippets: true,
    });
    const topScore = results[0]?.score ?? 0;
    return results.map((hit, index) => ({
      id: hit.node.id,
      title: hit.node.title,
      score:
        topScore > 0
          ? hit.score / topScore
          : (results.length - index) / results.length,
      rank: hit.rank,
      snippet: hit.snippet ?? "",
    }));
  }

  /**
   * Backlinks: notes that link to the referenced note. Answered by traversing
   * `linkedFrom`, which stores nothing — the ontology resolves it to stored
   * `linksTo` edges followed backwards.
   */
  async function backlinksOf(reference: string): Promise<readonly Backlink[]> {
    const id = resolveNoteId(reference);
    if (id === undefined) return [];
    return store
      .query()
      .from(NOTE_KIND, "target")
      .whereNode("target", (n) => n.id.eq(id))
      .traverse("linkedFrom", "e")
      .to(NOTE_KIND, "source")
      .select((ctx) => ({ id: ctx.source.id, title: ctx.source.title }))
      .execute();
  }

  /** Shortest undirected chain of `linksTo` edges connecting two notes. */
  async function shortestPathBetween(
    fromReference: string,
    toReference: string,
  ): Promise<PathResult> {
    const from = resolveNoteId(fromReference);
    const to = resolveNoteId(toReference);
    if (from === undefined || to === undefined) {
      return { found: false, depth: 0, pathNodeIds: [] };
    }
    const path = await store.algorithms.shortestPath(from, to, {
      edges: LINK_EDGES,
      direction: "both",
      maxHops: MAX_PATH_HOPS,
    });
    if (path === undefined) return { found: false, depth: 0, pathNodeIds: [] };
    return {
      found: true,
      depth: path.depth,
      pathNodeIds: path.nodes.map((node) => node.id),
    };
  }

  /** True when the opt-in Workers AI binding is available for embeddings. */
  function semanticEnabled(): boolean {
    return ai !== undefined;
  }

  /**
   * Brute-force semantic search: embed the query, then rank every note by
   * cosine similarity in plain JS. DO SQLite cannot load sqlite-vec, so there
   * is no vector index to push this into — pgvector or libSQL would serve an
   * indexed nearest-neighbour query instead.
   */
  async function semanticSearch(
    query: string,
    limit = DEFAULT_SEMANTIC_LIMIT,
  ): Promise<readonly SemanticHit[]> {
    const queryVector = await embed(query);
    if (queryVector === undefined) return [];

    const notes = await store.nodes.Note.find();
    return notes
      .flatMap((note) =>
        note.embedding === undefined
          ? []
          : [
              {
                id: note.id,
                title: note.title,
                score: cosineSimilarity(queryVector, note.embedding),
              },
            ],
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async function embed(text: string): Promise<readonly number[] | undefined> {
    if (ai === undefined) return undefined;
    const result = await ai.run(EMBEDDING_MODEL, { text });
    return extractEmbedding(result);
  }

  return {
    writeNote,
    searchNotes,
    backlinksOf,
    shortestPathBetween,
    semanticEnabled,
    semanticSearch,
  };
}

export type NotesOperations = Readonly<
  ReturnType<typeof createNotesOperations>
>;

/** Reads the first vector out of a Workers AI text-embedding response. */
function extractEmbedding(result: unknown): readonly number[] | undefined {
  const data = (result as Readonly<{ data?: unknown }>).data;
  if (!Array.isArray(data)) return undefined;
  const first: unknown = data[0];
  if (
    Array.isArray(first) &&
    first.length === EMBEDDING_DIMENSIONS &&
    first.every((value) => typeof value === "number")
  ) {
    return first;
  }
  return undefined;
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  for (const [index, value] of a.entries()) {
    const other = b[index] ?? 0;
    dot += value * other;
    magnitudeA += value ** 2;
    magnitudeB += other ** 2;
  }
  const denominator = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB);
  return denominator === 0 ? 0 : dot / denominator;
}
