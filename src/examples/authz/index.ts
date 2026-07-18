import { createStoreWithSchema } from "@nicia-ai/typegraph";
import { Hono } from "hono";

import { type ExampleModule, GRAPH_CHANGED } from "@/examples/types";
import { collectSnapshot, edgeSource, nodeSource } from "@/shared/snapshot";

import {
  type AuthzStore,
  check,
  loadNodes,
  relationsFor,
  resolveNode,
  type ResolvedNode,
} from "./check";
import { authzGraph, HAS_MEMBER, isRelation, MEMBER_OF } from "./graph";
import { seedWorkspace } from "./seed";

export const authzExample: ExampleModule = {
  name: "authz",
  description:
    "One graph per workspace: Zanzibar-lite permission checks answered by graph reachability.",
  boot: async ({ backend, broadcast }) => {
    const [store] = await createStoreWithSchema(authzGraph, backend);
    const app = new Hono();

    app.post("/seed", async (c) => {
      const workspace = await seedWorkspace(store);
      broadcast(GRAPH_CHANGED);
      return c.json({ ok: true, workspace });
    });

    app.get("/graph", async (c) =>
      c.json(
        await collectSnapshot(
          [
            nodeSource(store.nodes.User, (node) => node.name),
            nodeSource(store.nodes.Group, (node) => node.name),
            nodeSource(store.nodes.Folder, (node) => node.name),
            nodeSource(store.nodes.Doc, (node) => node.name),
          ],
          [
            // `hasMember` is intentionally omitted: it is a virtual inverse
            // of `memberOf` with zero stored edges.
            edgeSource(store.edges.memberOf),
            edgeSource(store.edges.parentOf),
            edgeSource(store.edges.owner),
            edgeSource(store.edges.editor),
            edgeSource(store.edges.viewer),
          ],
        ),
      ),
    );

    app.get("/check", async (c) => {
      const userParam = c.req.query("user");
      const relationParam = c.req.query("relation");
      const docParam = c.req.query("doc");
      if (!userParam || !relationParam || !docParam) {
        return c.json(
          { error: "check requires user, relation, and doc query params" },
          400,
        );
      }
      if (!isRelation(relationParam)) {
        return c.json(
          {
            error: `unknown relation: ${relationParam} (expected owner, editor, or viewer)`,
          },
          400,
        );
      }

      const subject = await resolveNode(store, userParam, ["user"]);
      if (subject === undefined) {
        return c.json({ error: `unknown user: ${userParam}` }, 404);
      }
      const target = await resolveNode(store, docParam, ["doc", "folder"]);
      if (target === undefined) {
        return c.json({ error: `unknown doc: ${docParam}` }, 404);
      }

      return c.json(await check(store, subject, relationParam, target));
    });

    app.get("/relations", async (c) => {
      const userParam = c.req.query("user");
      if (!userParam) {
        return c.json({ error: "relations requires a user query param" }, 400);
      }
      const subject = await resolveNode(store, userParam, ["user"]);
      if (subject === undefined) {
        return c.json({ error: `unknown user: ${userParam}` }, 404);
      }
      return c.json({
        user: subject.id,
        relations: await relationsFor(store, subject),
      });
    });

    app.get("/members", async (c) => {
      const groupParam = c.req.query("group");
      if (!groupParam) {
        return c.json({ error: "members requires a group query param" }, 400);
      }
      const group = await resolveNode(store, groupParam, ["group"]);
      if (group === undefined) {
        return c.json({ error: `unknown group: ${groupParam}` }, 404);
      }
      return c.json(await membersOf(store, group));
    });

    return app;
  },
};

/**
 * Group membership read two ways. `directUserMembers` traverses the virtual
 * `hasMember` edge — no `hasMember` row is ever stored; the ontology derives
 * it from `memberOf` read backwards. `members` is the transitive closure
 * (users and nested subgroups) via a reverse reachability query.
 */
async function membersOf(
  store: AuthzStore,
  group: ResolvedNode,
): Promise<
  Readonly<{
    group: ResolvedNode;
    inverseEdge: string | undefined;
    directUserMembers: readonly ResolvedNode[];
    members: readonly ResolvedNode[];
  }>
> {
  const directRows = await store
    .query()
    .from("Group", "g")
    .whereNode("g", ({ id }) => id.eq(group.id))
    .traverse(HAS_MEMBER, "e")
    .to("User", "member")
    .select((ctx) => ({ id: ctx.member.id, label: ctx.member.name }))
    .execute();

  const reached = await store.algorithms.reachable(group.id, {
    edges: [MEMBER_OF],
    direction: "in",
    excludeSource: true,
  });
  const byId = await loadNodes(store, reached);

  return {
    group,
    inverseEdge: store.registry.getInverseEdge(MEMBER_OF),
    directUserMembers: directRows.map((row) => ({
      id: row.id,
      kind: "User",
      label: row.label,
    })),
    members: reached
      .map((node) => byId.get(node.id))
      .filter((node): node is ResolvedNode => node !== undefined),
  };
}
