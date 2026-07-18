import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { apiUrl, getJson, postJson, seed, snapshot } from "./helpers";

function tenant(): string {
  return `user-${crypto.randomUUID()}`;
}

function seedNotes(user: string): Promise<{ ok: boolean; notes: number }> {
  return seed<{ ok: boolean; notes: number }>("notes", user);
}

function snap(user: string): ReturnType<typeof snapshot> {
  return snapshot("notes", user);
}

type SearchHit = Readonly<{
  id: string;
  title: string;
  score: number;
  snippet: string;
}>;

async function search(
  user: string,
  query: string,
): Promise<readonly SearchHit[]> {
  const { hits } = await getJson<{ hits: SearchHit[] }>(
    apiUrl("notes", user, `/search?q=${encodeURIComponent(query)}`),
  );
  return hits;
}

function writeNote(
  user: string,
  title: string,
  body: string,
): Promise<{ id: string; created: boolean; linksTo: string[] }> {
  return postJson(apiUrl("notes", user, "/notes"), { title, body });
}

describe("notes: full-text search", () => {
  it("returns ranked hits with highlighted snippets after seeding", async () => {
    const user = tenant();
    const { notes } = await seedNotes(user);
    expect(notes).toBeGreaterThanOrEqual(10);

    const hits = await search(user, "reachability");
    expect(hits.length).toBeGreaterThan(0);

    const scores = hits.map((hit) => hit.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));

    expect(hits.some((hit) => hit.snippet.includes("<mark>"))).toBe(true);
  });

  it("surfaces a non-degenerate relevance even for a corpus-common term", async () => {
    const user = tenant();
    await seedNotes(user);

    // Raw BM25 collapses toward zero for a term in most notes (search "graph"
    // in a graph-database garden), rendering as 0.00. The handler normalizes
    // relevance to the top hit so scores stay meaningful and never all-zero.
    const hits = await search(user, "graph");
    expect(hits.length).toBeGreaterThan(2);
    expect(hits[0]?.score).toBeCloseTo(1, 5);
    expect(hits.every((hit) => hit.score > 0.01)).toBe(true);

    const scores = hits.map((hit) => hit.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("finds exactly the one note that contains a rare word", async () => {
    const user = tenant();
    await seedNotes(user);

    // "Obsidian" appears only in the Wiki-Links note's body.
    const hits = await search(user, "Obsidian");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe("note:wiki-links");
  });

  it("re-seeding is idempotent", async () => {
    const user = tenant();
    const first = await seedNotes(user);
    const firstGraph = await snap(user);
    await seedNotes(user);
    const secondGraph = await snap(user);

    const second = await seedNotes(user);
    expect(second.notes).toBe(first.notes);
    expect(secondGraph.nodes.length).toBe(firstGraph.nodes.length);
    expect(secondGraph.edges.length).toBe(firstGraph.edges.length);
  });
});

describe("notes: backlinks via inverse traversal", () => {
  it("derives backlinks of a hub note without storing inverse edges", async () => {
    const user = tenant();
    await seedNotes(user);

    const { backlinks } = await getJson<{
      backlinks: { id: string; title: string }[];
    }>(apiUrl("notes", user, "/backlinks?note=Durable Objects"));

    const linkers = backlinks.map((entry) => entry.title).sort();
    expect(linkers).toEqual(
      [
        "Cloudflare Workers",
        "Full-Text Search",
        "Graph Databases",
        "TypeGraph",
        "WebSocket Hibernation",
      ].sort(),
    );

    // The backlink direction is never materialized: every stored edge is a
    // forward `linksTo`, and there are zero `linkedFrom` rows in the graph.
    const graph = await snap(user);
    const edgeKinds = new Set(graph.edges.map((edge) => edge.kind));
    expect([...edgeKinds]).toEqual(["linksTo"]);
  });
});

describe("notes: shortest path between notes", () => {
  it("connects two distant notes with a plausible path", async () => {
    const user = tenant();
    await seedNotes(user);

    const path = await getJson<{
      found: boolean;
      depth: number;
      pathNodeIds: string[];
    }>(apiUrl("notes", user, "/path?from=wiki-links&to=cloudflare-workers"));

    expect(path.found).toBe(true);
    expect(path.depth).toBeGreaterThanOrEqual(2);
    expect(path.pathNodeIds).toHaveLength(path.depth + 1);
    expect(path.pathNodeIds[0]).toBe("note:wiki-links");
    expect(path.pathNodeIds.at(-1)).toBe("note:cloudflare-workers");
  });

  it("reports no path to the orphan note", async () => {
    const user = tenant();
    await seedNotes(user);

    const path = await getJson<{ found: boolean; pathNodeIds: string[] }>(
      apiUrl("notes", user, "/path?from=typegraph&to=marginalia"),
    );
    expect(path.found).toBe(false);
    expect(path.pathNodeIds).toEqual([]);
  });
});

describe("notes: wiki-link authoring", () => {
  it("creates a placeholder note and edge for a new wiki-link", async () => {
    const user = tenant();
    const result = await writeNote(
      user,
      "Testbed",
      "This links to [[Fresh Concept]] for the first time.",
    );

    expect(result.created).toBe(true);
    expect(result.linksTo).toEqual(["note:fresh-concept"]);

    const graph = await snap(user);
    expect(graph.nodes.map((node) => node.id)).toContain("note:fresh-concept");
    expect(
      graph.edges.some(
        (edge) =>
          edge.from === "note:testbed" && edge.to === "note:fresh-concept",
      ),
    ).toBe(true);
  });

  it("removes stale links when a note is edited", async () => {
    const user = tenant();
    const created = await writeNote(
      user,
      "Editable",
      "Mentions [[Alpha Topic]] and [[Beta Topic]].",
    );
    expect(created.linksTo).toHaveLength(2);

    const edited = await writeNote(
      user,
      "Editable",
      "Now mentions only [[Alpha Topic]].",
    );
    expect(edited.created).toBe(false);
    expect(edited.linksTo).toEqual(["note:alpha-topic"]);

    const graph = await snap(user);
    const outgoing = graph.edges.filter(
      (edge) => edge.from === "note:editable",
    );
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]?.to).toBe("note:alpha-topic");
  });

  it("rejects a title with no addressable slug", async () => {
    const user = tenant();
    const response = await SELF.fetch(apiUrl("notes", user, "/notes"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "!!!", body: "Punctuation only." }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects a malformed JSON body", async () => {
    const user = tenant();
    const response = await SELF.fetch(apiUrl("notes", user, "/notes"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(response.status).toBe(400);
  });

  it("rejects oversized note fields", async () => {
    const user = tenant();
    for (const input of [
      { title: "x".repeat(201), body: "small" },
      { title: "small", body: "x".repeat(100_001) },
    ]) {
      const response = await SELF.fetch(apiUrl("notes", user, "/notes"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(400);
    }
  });

  it("rejects oversized search queries", async () => {
    const response = await SELF.fetch(
      apiUrl("notes", tenant(), `/search?q=${"x".repeat(1_001)}`),
    );
    expect(response.status).toBe(400);
  });

  it("ignores an unaddressable wiki-link target", async () => {
    const user = tenant();
    const result = await writeNote(
      user,
      "Punctuation Host",
      "This links to [[!!!]] which cannot be a note.",
    );
    expect(result.created).toBe(true);
    expect(result.linksTo).toEqual([]);

    // No placeholder was created and no bare "note:" id leaked into the graph.
    const graph = await snap(user);
    expect(graph.nodes.map((node) => node.id)).not.toContain("note:");
    expect(
      graph.edges.filter((edge) => edge.from === "note:punctuation-host"),
    ).toHaveLength(0);
  });
});

describe("notes: tenancy and opt-in features", () => {
  it("keeps each user's graph isolated", async () => {
    const owner = tenant();
    const stranger = tenant();
    await seedNotes(owner);

    const ownerGraph = await snap(owner);
    const strangerGraph = await snap(stranger);
    expect(ownerGraph.nodes.length).toBeGreaterThan(0);
    expect(strangerGraph.nodes).toHaveLength(0);
  });

  it("returns 503 for semantic search without the AI binding", async () => {
    const user = tenant();
    await seedNotes(user);

    const response = await SELF.fetch(
      apiUrl("notes", user, "/semantic?q=graph"),
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/ai binding/i);
  });
});
