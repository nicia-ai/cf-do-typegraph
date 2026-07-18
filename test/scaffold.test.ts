import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { getJson, postJson, seed, snapshot } from "./helpers";

describe("scaffold routing and tenancy", () => {
  it("seeds a tenant and reads its graph back", async () => {
    await seed("agent-memory", "isolation-a");

    const graph = await snapshot("agent-memory", "isolation-a");
    expect(graph.nodes.length).toBeGreaterThan(0);
  });

  it("gives every tenant its own isolated graph database", async () => {
    await seed("agent-memory", "isolation-b");

    const seededGraph = await snapshot("agent-memory", "isolation-b");
    const untouchedGraph = await snapshot("agent-memory", "isolation-b-empty");
    expect(seededGraph.nodes.length).toBeGreaterThan(0);
    expect(untouchedGraph.nodes).toHaveLength(0);
  });

  it("spawns many tenants in one request", async () => {
    const body = await postJson<{ seeded: string[] }>(
      "http://localhost/api/spawn/authz?count=5&prefix=spawned",
    );
    expect(body.seeded).toHaveLength(5);

    const graph = await snapshot("authz", "spawned-3");
    expect(graph.nodes.length).toBeGreaterThan(0);
  });

  it("rejects unknown examples", async () => {
    const response = await SELF.fetch("http://localhost/api/nope/tenant/graph");
    expect(response.status).toBe(404);
  });

  it("rejects prototype-chain keys as example names", async () => {
    for (const name of ["toString", "constructor", "hasOwnProperty"]) {
      const routed = await SELF.fetch(`http://localhost/api/${name}/t1/graph`);
      expect(routed.status).toBe(404);
      const spawned = await SELF.fetch(`http://localhost/api/spawn/${name}`, {
        method: "POST",
      });
      expect(spawned.status).toBe(404);
    }
  });

  it("rejects tenant names outside the safe charset with a 400", async () => {
    for (const tenant of ["team%20a", "caf%C3%A9", "a%0d%0ax", "a:b"]) {
      const response = await SELF.fetch(
        `http://localhost/api/notes/${tenant}/graph`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("tenant");
    }
  });

  it("accepts dotted and hyphenated tenant names", async () => {
    const graph = await snapshot("notes", "team-a.prod_2");
    expect(graph.nodes).toHaveLength(0);
  });

  it("rejects invalid spawn prefixes with a 400", async () => {
    const response = await SELF.fetch(
      "http://localhost/api/spawn/notes?prefix=bad%20prefix",
      { method: "POST" },
    );
    expect(response.status).toBe(400);
  });

  it("reports spawn outcomes as seeded and failed lists", async () => {
    const body = await postJson<{ seeded: string[]; failed: unknown[] }>(
      "http://localhost/api/spawn/notes?count=3&prefix=outcome",
    );
    expect(body.seeded).toEqual(["outcome-1", "outcome-2", "outcome-3"]);
    expect(body.failed).toEqual([]);
  });

  it("lists the available examples", async () => {
    const body = await getJson<{ examples: { name: string }[] }>(
      "http://localhost/api/examples",
    );
    expect(body.examples.map((e) => e.name)).toEqual([
      "agent-memory",
      "authz",
      "notes",
    ]);
  });

  it("keeps the API disabled on non-local hosts by default", async () => {
    const response = await SELF.fetch("https://public.example/api/examples");
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("public API disabled");
  });

  it("rejects request bodies over 128 KiB", async () => {
    const response = await SELF.fetch(
      "http://localhost/api/notes/body-limit/notes",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "large", body: "x".repeat(140_000) }),
      },
    );
    expect(response.status).toBe(413);
  });
});
