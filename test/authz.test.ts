import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { apiUrl, getJson, seed, snapshot } from "./helpers";

type ResolvedNode = Readonly<{ id: string; kind: string; label: string }>;
type CheckVia = Readonly<{
  grantSubject: string;
  grantRelation: string;
  grantTarget: string;
}>;
type CheckResult = Readonly<{
  allowed: boolean;
  relation: string;
  subject: string;
  via?: CheckVia;
  pathNodeIds: readonly string[];
  pathEdgeKinds: readonly string[];
}>;
type RelationsResult = Readonly<{
  user: string;
  relations: Readonly<{
    owner: readonly ResolvedNode[];
    editor: readonly ResolvedNode[];
    viewer: readonly ResolvedNode[];
  }>;
}>;
type MembersResult = Readonly<{
  group: ResolvedNode;
  inverseEdge: string | undefined;
  directUserMembers: readonly ResolvedNode[];
  members: readonly ResolvedNode[];
}>;

function checkUrl(
  tenant: string,
  user: string,
  relation: string,
  doc: string,
): string {
  return apiUrl(
    "authz",
    tenant,
    `/check?user=${user}&relation=${relation}&doc=${doc}`,
  );
}

/** Raw check, exposing the status so denial tests can assert 404/400. */
async function check(
  tenant: string,
  user: string,
  relation: string,
  doc: string,
): Promise<{ status: number; body: CheckResult }> {
  const response = await SELF.fetch(checkUrl(tenant, user, relation, doc));
  return {
    status: response.status,
    body: (await response.json()) as CheckResult,
  };
}

/** A check expected to succeed; asserts 200 and returns the witness. */
function allowed(
  tenant: string,
  user: string,
  relation: string,
  doc: string,
): Promise<CheckResult> {
  return getJson<CheckResult>(checkUrl(tenant, user, relation, doc));
}

describe("authz seed and snapshot", () => {
  it("seeds an idempotent workspace and reports a summary", async () => {
    const tenant = "seed-summary";
    const body = await seed<{
      ok: boolean;
      workspace: { users: number; grants: number };
    }>("authz", tenant);
    expect(body.ok).toBe(true);
    expect(body.workspace.users).toBe(5);
    expect(body.workspace.grants).toBe(3);

    // Re-seeding does not duplicate nodes or edges.
    await seed("authz", tenant);
    const graph = await snapshot("authz", tenant);
    expect(graph.nodes).toHaveLength(13);
    expect(graph.edges).toHaveLength(12);
  });
});

describe("authz check resolution", () => {
  it("allows a direct per-doc grant", async () => {
    const tenant = "direct";
    await seed("authz", tenant);
    const result = await allowed(tenant, "carol", "viewer", "doc:roadmap");
    expect(result.allowed).toBe(true);
    expect(result.via).toEqual({
      grantSubject: "user:carol",
      grantRelation: "viewer",
      grantTarget: "doc:roadmap",
    });
    expect(result.pathNodeIds).toEqual(["user:carol", "doc:roadmap"]);
  });

  it("lets a stronger relation satisfy a weaker check (owner ⇒ viewer)", async () => {
    const tenant = "implication";
    await seed("authz", tenant);
    const result = await allowed(tenant, "dave", "viewer", "doc:handbook");
    expect(result.allowed).toBe(true);
    expect(result.via?.grantRelation).toBe("owner");
  });

  it("inherits access from a directly-held group grant", async () => {
    const tenant = "group";
    await seed("authz", tenant);
    const result = await allowed(tenant, "bob", "editor", "folder:engineering");
    expect(result.allowed).toBe(true);
    expect(result.via?.grantSubject).toBe("group:staff");
    expect(result.pathNodeIds).toEqual([
      "user:bob",
      "group:staff",
      "folder:engineering",
    ]);
  });

  it("inherits access through a nested group", async () => {
    const tenant = "nested";
    await seed("authz", tenant);
    const result = await allowed(
      tenant,
      "alice",
      "editor",
      "folder:engineering",
    );
    expect(result.allowed).toBe(true);
    expect(result.pathNodeIds).toEqual([
      "user:alice",
      "group:eng",
      "group:staff",
      "folder:engineering",
    ]);
    expect(result.pathEdgeKinds).toEqual(["memberOf", "memberOf", "editor"]);
  });

  it("inherits access from a grant on an ancestor folder", async () => {
    const tenant = "folder";
    await seed("authz", tenant);
    const result = await allowed(tenant, "bob", "editor", "doc:roadmap");
    expect(result.allowed).toBe(true);
    // staff → engineering (grant), engineering → specs → roadmap (folder tree).
    expect(result.pathNodeIds).toEqual([
      "user:bob",
      "group:staff",
      "folder:engineering",
      "folder:specs",
      "doc:roadmap",
    ]);
    expect(result.pathEdgeKinds).toEqual([
      "memberOf",
      "editor",
      "parentOf",
      "parentOf",
    ]);
  });

  it("resolves nesting, implication, and folder inheritance at once", async () => {
    const tenant = "combined";
    await seed("authz", tenant);
    // Alice ∈ eng ∈ staff; staff is EDITOR of engineering (implies viewer);
    // engineering contains specs contains roadmap.
    const result = await allowed(tenant, "alice", "viewer", "doc:roadmap");
    expect(result.allowed).toBe(true);
    expect(result.via).toEqual({
      grantSubject: "group:staff",
      grantRelation: "editor",
      grantTarget: "folder:engineering",
    });
    expect(result.pathNodeIds).toEqual([
      "user:alice",
      "group:eng",
      "group:staff",
      "folder:engineering",
      "folder:specs",
      "doc:roadmap",
    ]);
    expect(result.pathEdgeKinds).toEqual([
      "memberOf",
      "memberOf",
      "editor",
      "parentOf",
      "parentOf",
    ]);

    // The witness is a connected chain: every edge kind bridges two nodes.
    expect(result.pathEdgeKinds).toHaveLength(result.pathNodeIds.length - 1);
  });

  it("accepts bare names and full ids interchangeably", async () => {
    const tenant = "bare";
    await seed("authz", tenant);
    const bare = await allowed(tenant, "alice", "viewer", "roadmap");
    const full = await allowed(tenant, "user:alice", "viewer", "doc:roadmap");
    expect(bare.pathNodeIds).toEqual(full.pathNodeIds);
  });
});

describe("authz denials", () => {
  it("denies a user with no path to the resource", async () => {
    const tenant = "no-path";
    await seed("authz", tenant);
    const result = await allowed(tenant, "erin", "viewer", "doc:roadmap");
    expect(result.allowed).toBe(false);
    expect(result.pathNodeIds).toEqual([]);
    expect(result.pathEdgeKinds).toEqual([]);
    expect(result.via).toBeUndefined();
  });

  it("denies a stronger check against a weaker grant", async () => {
    const tenant = "too-weak";
    await seed("authz", tenant);
    // Carol holds only a viewer grant on the roadmap.
    const result = await allowed(tenant, "carol", "editor", "doc:roadmap");
    expect(result.allowed).toBe(false);
  });

  it("returns 404 for unknown subjects and resources", async () => {
    const tenant = "unknown";
    await seed("authz", tenant);
    expect(
      (await check(tenant, "nobody", "viewer", "doc:roadmap")).status,
    ).toBe(404);
    expect((await check(tenant, "alice", "viewer", "doc:ghost")).status).toBe(
      404,
    );
  });

  it("rejects an unknown relation with 400", async () => {
    const tenant = "bad-relation";
    await seed("authz", tenant);
    const response = await SELF.fetch(
      checkUrl(tenant, "alice", "admin", "doc:roadmap"),
    );
    expect(response.status).toBe(400);
  });
});

describe("authz relations sweep", () => {
  it("lists every resource a user can reach per relation", async () => {
    const tenant = "sweep";
    await seed("authz", tenant);
    const body = await getJson<RelationsResult>(
      apiUrl("authz", tenant, "/relations?user=alice"),
    );

    const viewerIds = body.relations.viewer.map((node) => node.id);
    // Alice's staff editor grant on engineering fans out to the whole tree.
    expect(viewerIds).toEqual(
      expect.arrayContaining([
        "folder:engineering",
        "folder:specs",
        "doc:roadmap",
        "doc:api",
        "doc:handbook",
      ]),
    );
    // editor implies viewer, so both lists match; nobody granted her owner.
    expect(body.relations.editor.map((node) => node.id).sort()).toEqual(
      viewerIds.sort(),
    );
    expect(body.relations.owner).toEqual([]);
  });

  it("scopes a direct-only grant to a single doc", async () => {
    const tenant = "sweep-direct";
    await seed("authz", tenant);
    const body = await getJson<RelationsResult>(
      apiUrl("authz", tenant, "/relations?user=carol"),
    );
    expect(body.relations.viewer.map((node) => node.id)).toEqual([
      "doc:roadmap",
    ]);
    expect(body.relations.editor).toEqual([]);
  });
});

describe("authz group membership (inverse edges)", () => {
  it("reads members via the virtual hasMember inverse and transitive closure", async () => {
    const tenant = "members";
    await seed("authz", tenant);
    const body = await getJson<MembersResult>(
      apiUrl("authz", tenant, "/members?group=staff"),
    );

    // The ontology knows memberOf's inverse without any stored hasMember edge.
    expect(body.inverseEdge).toBe("hasMember");
    // Bob is a direct member; the eng subgroup and Alice are not direct users.
    expect(body.directUserMembers.map((node) => node.id)).toEqual(["user:bob"]);
    // Transitive closure reaches the nested subgroup and its members.
    const memberIds = body.members.map((node) => node.id);
    expect(memberIds).toEqual(
      expect.arrayContaining(["group:eng", "user:bob", "user:alice"]),
    );
  });
});

describe("authz tenant isolation", () => {
  it("keeps each workspace's graph private", async () => {
    await seed("authz", "tenant-a");

    // A never-seeded workspace knows none of tenant-a's nodes.
    const fresh = await snapshot("authz", "tenant-b-empty");
    expect(fresh.nodes).toHaveLength(0);

    const isolated = await check(
      "tenant-b-empty",
      "alice",
      "viewer",
      "doc:roadmap",
    );
    expect(isolated.status).toBe(404);
  });
});

describe("authz id-prefix allowlist", () => {
  it("rejects a subject-kind id supplied as the doc target", async () => {
    const tenant = "allowlist-doc";
    await seed("authz", tenant);
    // A group is a subject, not a resource: resolving it as the target would
    // let a memberOf-only path (no grant crossing) read as ALLOWED.
    const result = await check(tenant, "alice", "viewer", "group:staff");
    expect(result.status).toBe(404);
    expect(result.body.allowed).not.toBe(true);
  });

  it("rejects a resource-kind id supplied as the user subject", async () => {
    const tenant = "allowlist-user";
    await seed("authz", tenant);
    const result = await check(tenant, "doc:roadmap", "viewer", "doc:roadmap");
    expect(result.status).toBe(404);
  });

  it("still resolves a legitimate folder target", async () => {
    const tenant = "allowlist-folder";
    await seed("authz", tenant);
    // Folders are valid resources: Alice inherits viewer on specs via the
    // staff editor grant on the engineering folder above it.
    const result = await allowed(tenant, "alice", "viewer", "folder:specs");
    expect(result.allowed).toBe(true);
  });
});
