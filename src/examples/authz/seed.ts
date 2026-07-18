import type { AuthzStore } from "./check";

/**
 * A deterministic company workspace that exercises every mechanism:
 * nested groups, a two-deep folder tree, a group-granted editor on a top
 * folder, a direct per-doc viewer grant, an owner grant (for implication),
 * and a user with no access at all. Re-running is a no-op — nodes upsert by
 * id and edges get-or-create by endpoints.
 */

type NodeSeed = Readonly<{ id: string; name: string }>;

const USERS: readonly NodeSeed[] = [
  { id: "user:alice", name: "Alice" },
  { id: "user:bob", name: "Bob" },
  { id: "user:carol", name: "Carol" },
  { id: "user:dave", name: "Dave" },
  { id: "user:erin", name: "Erin" },
];

const GROUPS: readonly NodeSeed[] = [
  { id: "group:eng", name: "Engineering Team" },
  { id: "group:staff", name: "Staff" },
  { id: "group:security", name: "Security" },
];

const FOLDERS: readonly NodeSeed[] = [
  { id: "folder:engineering", name: "Engineering" },
  { id: "folder:specs", name: "Specs" },
];

const DOCS: readonly NodeSeed[] = [
  { id: "doc:roadmap", name: "Product Roadmap" },
  { id: "doc:api", name: "API Design" },
  { id: "doc:handbook", name: "Handbook" },
];

const user = (id: string) => ({ kind: "User", id }) as const;
const group = (id: string) => ({ kind: "Group", id }) as const;
const folder = (id: string) => ({ kind: "Folder", id }) as const;
const doc = (id: string) => ({ kind: "Doc", id }) as const;

/** `eng` nests inside `staff`; Erin belongs to nothing (the denial case). */
const MEMBERSHIPS = [
  [group("group:eng"), group("group:staff")],
  [user("user:alice"), group("group:eng")],
  [user("user:bob"), group("group:staff")],
  [user("user:carol"), group("group:security")],
  [user("user:dave"), group("group:security")],
] as const;

const PARENTAGE = [
  [folder("folder:engineering"), folder("folder:specs")],
  [folder("folder:specs"), doc("doc:roadmap")],
  [folder("folder:specs"), doc("doc:api")],
  [folder("folder:engineering"), doc("doc:handbook")],
] as const;

const GRANTS = [
  // Whole-tree editor via a nested group: reaches every descendant doc.
  {
    relation: "editor",
    from: group("group:staff"),
    to: folder("folder:engineering"),
  },
  // A single direct per-doc viewer grant (Carol's only access).
  { relation: "viewer", from: user("user:carol"), to: doc("doc:roadmap") },
  // A direct owner grant that must satisfy editor/viewer checks by implication.
  { relation: "owner", from: user("user:dave"), to: doc("doc:handbook") },
] as const;

type GrantSeed = (typeof GRANTS)[number];

export type WorkspaceSummary = Readonly<{
  users: number;
  groups: number;
  folders: number;
  docs: number;
  memberships: number;
  parentage: number;
  grants: number;
}>;

export async function seedWorkspace(
  store: AuthzStore,
): Promise<WorkspaceSummary> {
  await Promise.all([
    ...USERS.map((node) =>
      store.nodes.User.upsertById(node.id, { name: node.name }),
    ),
    ...GROUPS.map((node) =>
      store.nodes.Group.upsertById(node.id, { name: node.name }),
    ),
    ...FOLDERS.map((node) =>
      store.nodes.Folder.upsertById(node.id, { name: node.name }),
    ),
    ...DOCS.map((node) =>
      store.nodes.Doc.upsertById(node.id, { name: node.name }),
    ),
  ]);

  await Promise.all([
    ...MEMBERSHIPS.map(([from, to]) =>
      store.edges.memberOf.getOrCreateByEndpoints(from, to, {}),
    ),
    ...PARENTAGE.map(([from, to]) =>
      store.edges.parentOf.getOrCreateByEndpoints(from, to, {}),
    ),
    ...GRANTS.map((grant) => grantEdge(store, grant)),
  ]);

  return {
    users: USERS.length,
    groups: GROUPS.length,
    folders: FOLDERS.length,
    docs: DOCS.length,
    memberships: MEMBERSHIPS.length,
    parentage: PARENTAGE.length,
    grants: GRANTS.length,
  };
}

function grantEdge(store: AuthzStore, grant: GrantSeed): Promise<unknown> {
  return store
    .getEdgeCollectionOrThrow(grant.relation)
    .getOrCreateByEndpoints(grant.from, grant.to, {});
}
