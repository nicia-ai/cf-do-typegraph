import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { GraphSnapshot } from "@/examples/types";

import { apiUrl, getJson, postJson, seed, snapshot } from "./helpers";

const SCRIPT_LENGTH = 12;
const FULL_NODE_COUNT = 21; // 12 Message + 3 Person + 4 Topic + 1 Place + 1 Organization
const FULL_EDGE_COUNT = 37; // 25 mentions + 11 relations + 1 worksAt

type TimelineEntry = Readonly<{
  index: number;
  role: string;
  text: string;
  recordedAt: string | null;
}>;

type StepResult = Readonly<{
  index: number;
  total: number;
  done: boolean;
  message: string;
}>;

function seedMemory(
  tenant: string,
): Promise<{ applied: number; total: number }> {
  return seed<{ applied: number; total: number }>("agent-memory", tenant);
}

function step(tenant: string): Promise<StepResult> {
  return postJson<StepResult>(apiUrl("agent-memory", tenant, "/replay/step"));
}

function snap(tenant: string, recorded?: string): Promise<GraphSnapshot> {
  const query =
    recorded === undefined ? "" : `?recorded=${encodeURIComponent(recorded)}`;
  return snapshot("agent-memory", tenant, query);
}

async function timeline(tenant: string): Promise<readonly TimelineEntry[]> {
  const { steps } = await getJson<{ steps: TimelineEntry[] }>(
    apiUrl("agent-memory", tenant, "/timeline"),
  );
  return steps;
}

function hasNode(graph: GraphSnapshot, id: string): boolean {
  return graph.nodes.some((node) => node.id === id);
}

function kinds(graph: GraphSnapshot): ReadonlySet<string> {
  return new Set(graph.nodes.map((node) => node.kind));
}

describe("agent-memory replay", () => {
  it("seeds the whole conversation into one graph", async () => {
    const result = await seedMemory("seed-all");
    expect(result).toEqual({ applied: SCRIPT_LENGTH, total: SCRIPT_LENGTH });

    const graph = await snap("seed-all");
    expect(graph.nodes).toHaveLength(FULL_NODE_COUNT);
    expect(graph.edges).toHaveLength(FULL_EDGE_COUNT);
    expect(hasNode(graph, "person:ada")).toBe(true);
    expect(hasNode(graph, "place:berlin")).toBe(true);
    expect(hasNode(graph, "org:northwind")).toBe(true);
  });

  it("is idempotent — re-seeding applies nothing", async () => {
    await seedMemory("seed-twice");
    const again = await seedMemory("seed-twice");
    expect(again.applied).toBe(0);
    const graph = await snap("seed-twice");
    expect(graph.nodes).toHaveLength(FULL_NODE_COUNT);
  });

  it("advances the timeline one message at a time", async () => {
    const tenant = "step-by-step";
    for (let expected = 1; expected <= SCRIPT_LENGTH; expected += 1) {
      const result = await step(tenant);
      expect(result.index).toBe(expected);
      expect(result.total).toBe(SCRIPT_LENGTH);
      expect(result.message.length).toBeGreaterThan(0);

      const entries = await timeline(tenant);
      expect(entries).toHaveLength(expected);
      expect(entries.at(-1)?.index).toBe(expected);
    }

    // The script is exhausted; one more step is a no-op.
    const done = await step(tenant);
    expect(done.done).toBe(true);
    expect(done.message).toBe("");
    expect(await timeline(tenant)).toHaveLength(SCRIPT_LENGTH);
  });

  it("time-travels: an early recorded instant holds fewer nodes", async () => {
    const tenant = "time-travel";
    await seedMemory(tenant);

    const entries = await timeline(tenant);
    // Berlin enters at message 5; message 4's instant predates it.
    const beforeBerlin = entries.find((entry) => entry.index === 4);
    expect(beforeBerlin?.recordedAt).toBeTypeOf("string");

    const past = await snap(tenant, beforeBerlin?.recordedAt ?? "");
    const now = await snap(tenant);

    expect(past.nodes.length).toBeLessThan(now.nodes.length);
    expect(hasNode(past, "place:berlin")).toBe(false);
    expect(hasNode(now, "place:berlin")).toBe(true);
    // Facts recorded before message 4 are already present in the past view.
    expect(hasNode(past, "person:ada")).toBe(true);
  });

  it("rejects a recorded value that is not a timeline instant", async () => {
    const tenant = "bad-recorded";
    await seedMemory(tenant);

    for (const recorded of ["yesterday", "x".repeat(300)]) {
      const response = await SELF.fetch(
        apiUrl(
          "agent-memory",
          tenant,
          `/graph?recorded=${encodeURIComponent(recorded)}`,
        ),
      );
      expect(response.status).toBe(400);
    }
  });

  it("evolves the schema mid-conversation to add Organization", async () => {
    const tenant = "evolution";
    // Replay the seven messages before the partnership is announced.
    for (let applied = 0; applied < 7; applied += 1) {
      await step(tenant);
    }
    const before = await snap(tenant);
    expect(kinds(before).has("Organization")).toBe(false);
    expect(hasNode(before, "org:northwind")).toBe(false);

    // Message 8 carries the graph extension.
    const evolving = await step(tenant);
    expect(evolving.index).toBe(8);

    const after = await snap(tenant);
    expect(kinds(after).has("Organization")).toBe(true);
    expect(hasNode(after, "org:northwind")).toBe(true);
    expect(after.edges.some((edge) => edge.kind === "worksAt")).toBe(true);
  });

  it("keeps every session isolated — a fresh tenant is empty", async () => {
    await seedMemory("isolated-full");
    const empty = await snap("isolated-fresh");
    expect(empty.nodes).toHaveLength(0);
    expect(empty.edges).toHaveLength(0);
  });

  it("refuses the AI path when the ai binding is absent", async () => {
    const response = await SELF.fetch(
      apiUrl("agent-memory", "ai-tenant", "/messages"),
      {
        method: "POST",
        body: JSON.stringify({ text: "Grace works with Ada." }),
      },
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("wrangler.jsonc");
  });

  it("validates AI messages before checking the optional binding", async () => {
    for (const text of ["   ", "x".repeat(10_001)]) {
      const response = await SELF.fetch(
        apiUrl("agent-memory", "invalid-ai-message", "/messages"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        },
      );
      expect(response.status).toBe(400);
    }
  });

  it("converges when a partially replayed session is seeded", async () => {
    const tenant = "resume-converge";
    // Advance partway with step-by-step replay...
    for (let applied = 0; applied < 4; applied += 1) await step(tenant);
    expect(await timeline(tenant)).toHaveLength(4);

    // ...then a full seed completes exactly the remaining steps.
    const seeded = await seedMemory(tenant);
    expect(seeded).toEqual({ applied: 8, total: SCRIPT_LENGTH });

    const graph = await snap(tenant);
    expect(graph.nodes).toHaveLength(FULL_NODE_COUNT);
    expect(graph.edges).toHaveLength(FULL_EDGE_COUNT);
    expect(await timeline(tenant)).toHaveLength(SCRIPT_LENGTH);

    // Every write is idempotent, so re-covering the same ground duplicates
    // nothing — a further step is a no-op and a further seed applies zero.
    const done = await step(tenant);
    expect(done.done).toBe(true);
    const again = await seedMemory(tenant);
    expect(again.applied).toBe(0);
    const settled = await snap(tenant);
    expect(settled.nodes).toHaveLength(FULL_NODE_COUNT);
    expect(settled.edges).toHaveLength(FULL_EDGE_COUNT);
  });
});
