import type { NotesOperations } from "./operations";

type SeedNote = Readonly<{ title: string; body: string }>;

/**
 * A small deterministic digital garden about graph databases, Durable
 * Objects, and TypeGraph itself. It is richly interlinked through
 * `[[wiki-links]]`, with one hub ("Graph Databases", linking out to most of
 * the garden) and one orphan ("Marginalia", with no links in or out). Bodies
 * are real prose so full-text queries like "reachability" or "hibernation"
 * return satisfying snippet hits. Re-seeding is idempotent: every note is
 * upserted by slug and its links re-derived, so the graph converges to the
 * same shape no matter how many times it runs or in what order.
 */
const SEED_NOTES: readonly SeedNote[] = [
  {
    title: "Graph Databases",
    body: "A graph database stores data as nodes and the edges between them, making relationships first-class instead of something you reconstruct with joins. That shape pays off for questions about connection: [[Reachability]], shortest paths, and neighbourhood queries stay cheap as the graph grows. This garden explores running one on [[Durable Objects]] with [[TypeGraph]], and leans on [[Full-Text Search]], [[Ontology and Inference]], and the humble [[Edge]] to do it.",
  },
  {
    title: "Durable Objects",
    body: "A Durable Object is a single-threaded, addressable piece of compute on [[Cloudflare Workers]], each with its own private SQLite database at the edge. Because every instance is isolated by name, one object per tenant becomes a whole graph database with no `WHERE tenant_id` in sight. Idle objects enter [[WebSocket Hibernation]] and wake on the next request, so a per-user graph costs nothing while nobody is reading it.",
  },
  {
    title: "TypeGraph",
    body: "[[TypeGraph]] is a typed graph layer that turns a plain SQLite database into a property graph with nodes, typed edges, and an [[Ontology and Inference]] system. It runs unchanged inside a [[Durable Objects]] instance, which is what makes a graph-database-per-tenant practical. It also provides [[Full-Text Search]] over node fields and the traversal primitives behind [[Reachability]] and [[Backlinks]].",
  },
  {
    title: "Full-Text Search",
    body: "Full-text search here is real FTS5 running inside the Durable Object's own SQLite — no external search service, no separate index to keep warm. Fields marked searchable are indexed with BM25 and kept in sync on every write, so a query for a rare word returns ranked, highlighted snippets. It surprises people that [[Durable Objects]] support the fts5 virtual table natively; vector indexes are the capability that is missing.",
  },
  {
    title: "Reachability",
    body: "Reachability asks whether you can get from one node to another by following edges, and if so, how far. On a graph it is a recursive walk over [[Edge]] rows; in raw SQL it is an awkward recursive CTE you would rather not hand-write. [[TypeGraph]] answers it with shortest-path and reachable queries, which is how this garden draws the chain between two distant notes.",
  },
  {
    title: "WebSocket Hibernation",
    body: "WebSocket hibernation lets a [[Durable Objects]] instance keep long-lived sockets open while evicting itself from memory between events. The runtime tracks the sockets for you and re-delivers messages after the object wakes, so a live view of the graph survives long idle gaps without holding memory. Hibernation is why a per-tenant graph can stay subscribable and still cost nothing at rest.",
  },
  {
    title: "Ontology and Inference",
    body: "An ontology declares how edge types relate — that one implies another, or that two are inverses. [[TypeGraph]] uses these relations to answer queries about edges that were never stored: an `inverseOf` relation turns forward links into [[Backlinks]] for free. This garden defines exactly one such relation, and it is what makes the backlink panel work without a second set of rows.",
  },
  {
    title: "Backlinks",
    body: "Backlinks are the notes that point at the current note — the reverse of its outgoing [[wiki-links]]. Rather than store a second edge in the other direction, this garden derives them by traversing the forward [[Edge]] inversely, using the `inverseOf` relation from [[Ontology and Inference]]. Zero extra rows, and they can never fall out of sync with the links that produced them.",
  },
  {
    title: "Wiki-Links",
    body: "A wiki-link is the double-bracket target syntax you write inside a note body. On write, each target is slugified and turned into a `linksTo` edge; targets that do not exist yet are created as empty placeholder notes, the way Obsidian does. Editing a note re-derives its links from the current body, so removing a wiki-link removes its [[Edge]] and its [[Backlinks]] entry.",
  },
  {
    title: "Edge",
    body: "An edge is a typed, directed connection between two nodes — the unit that makes a graph a graph. In this garden every [[Wiki-Links]] reference becomes one `linksTo` edge, and the whole web of [[Reachability]], shortest paths, and [[Backlinks]] is just those edges read in different directions. Store the edge once; read it forwards for links and backwards for backlinks.",
  },
  {
    title: "Cloudflare Workers",
    body: "Cloudflare Workers run code at the edge, close to the user, with [[Durable Objects]] providing the stateful, single-instance counterpart to their stateless request handlers. Together they let a graph database materialize on demand at whichever edge location a tenant is nearest. No provisioning step, no connection pool — addressing an object by name is the whole deployment.",
  },
  {
    title: "Marginalia",
    body: "A stray thought with nowhere to file it and nothing that points back. This note links to nothing and nothing links to it — the orphan that every knowledge graph accumulates. It is here on purpose, so the graph view has an unconnected node and search has something off the beaten path to find.",
  },
];

/** Writes the digital garden through the standard note-write path. */
export async function seedGarden(operations: NotesOperations): Promise<number> {
  for (const note of SEED_NOTES) {
    await operations.writeNote(note.title, note.body);
  }
  return SEED_NOTES.length;
}
