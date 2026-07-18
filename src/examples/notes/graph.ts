import {
  defineEdge,
  defineGraph,
  defineNode,
  embedding,
  inverseOf,
  searchable,
  type Store,
} from "@nicia-ai/typegraph";
import { z } from "zod";

/**
 * Dimensionality of `@cf/baai/bge-base-en-v1.5`, the Workers AI model the
 * optional semantic-search path embeds with.
 */
export const EMBEDDING_DIMENSIONS = 768;

/**
 * A note in a personal knowledge graph. `title` and `body` are
 * `searchable()`, so TypeGraph provisions the FTS5 virtual table at boot and
 * keeps it in sync on every write — full-text search runs entirely inside the
 * Durable Object's own SQLite. `embedding` is only populated when the opt-in
 * Workers AI binding is present; the default path never touches it.
 */
export const Note = defineNode("Note", {
  schema: z.object({
    slug: z.string(),
    title: searchable({ language: "english" }),
    body: searchable({ language: "english" }),
    embedding: embedding(EMBEDDING_DIMENSIONS).optional(),
  }),
});

/** A `[[wiki-link]]` from one note's body to another note. */
export const linksTo = defineEdge("linksTo", { schema: z.object({}) });

/**
 * The backlink direction. No `linkedFrom` edge is ever stored: the
 * `inverseOf(linksTo, linkedFrom)` ontology below lets a `linkedFrom`
 * traversal follow stored `linksTo` edges backwards, so backlinks cost zero
 * extra rows and can never drift out of sync with the forward links.
 */
export const linkedFrom = defineEdge("linkedFrom", { schema: z.object({}) });

export const notesGraph = defineGraph({
  id: "notes",
  nodes: {
    Note: { type: Note },
  },
  edges: {
    linksTo: { type: linksTo, from: [Note], to: [Note] },
    linkedFrom: { type: linkedFrom, from: [Note], to: [Note] },
  },
  ontology: [inverseOf(linksTo, linkedFrom)],
});

export type NotesStore = Store<typeof notesGraph>;
