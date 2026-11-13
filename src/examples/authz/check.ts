import type { Store } from "@nicia-ai/typegraph";

import { nameOrKind } from "@/shared/snapshot";

import {
  type authzGraph,
  isResourceKind,
  isSubjectKind,
  KIND_BY_PREFIX,
  MEMBER_OF,
  PARENT_OF,
  type Relation,
  RELATION_KINDS,
} from "./graph";

export type AuthzStore = Store<typeof authzGraph>;

/** The `{ kind, id }` shape `store.algorithms` and `.find` return. */
type GraphNodeRef = Readonly<{ id: string; kind: string }>;

export type ResolvedNode = Readonly<{
  id: string;
  kind: string;
  label: string;
}>;

export type CheckVia = Readonly<{
  grantSubject: string;
  grantRelation: string;
  grantTarget: string;
}>;

/**
 * The witness the viz highlights. `pathNodeIds` is the connected chain
 * `subject → … → group → grantTarget → … → doc` when allowed, and empty
 * when denied; `pathEdgeKinds[i]` is the edge kind joining node `i` to `i+1`.
 */
export type CheckResult = Readonly<{
  allowed: boolean;
  relation: string;
  subject: string;
  via?: CheckVia;
  pathNodeIds: readonly string[];
  pathEdgeKinds: readonly string[];
}>;

/** Deep enough for nested groups plus a folder tree; the demo needs far less. */
const MAX_HOPS = 32;

type AuthzEdgeKind = typeof MEMBER_OF | typeof PARENT_OF | Relation;

/**
 * An authorization check is one reachability question. Because relation
 * edges are the *only* edges bridging subjects (`User`/`Group`) to resources
 * (`Folder`/`Doc`), every outgoing path
 *
 *   subject —memberOf*→ grantSubject —R'→ grantTarget —parentOf*→ target
 *
 * is forced into Zanzibar order: membership closure, then exactly one grant
 * whose relation implies `relation` (owner ⇒ editor ⇒ viewer), then folder
 * inheritance. `expandImplyingEdges` turns `relation` into that grant set
 * straight from the ontology, so no implication logic lives here.
 */
export async function check(
  store: AuthzStore,
  subject: ResolvedNode,
  relation: Relation,
  target: ResolvedNode,
): Promise<CheckResult> {
  const { grantKinds, edges } = traversalAlphabet(store, relation);

  const path = await store.algorithms.shortestPath(subject.id, target.id, {
    edges,
    direction: "out",
    maxHops: MAX_HOPS,
  });

  if (path === undefined) {
    return {
      allowed: false,
      relation,
      subject: subject.id,
      pathNodeIds: [],
      pathEdgeKinds: [],
    };
  }

  const witness = await describePath(store, path.nodes, grantKinds);
  return {
    allowed: true,
    relation,
    subject: subject.id,
    ...(witness.via === undefined ? {} : { via: witness.via }),
    pathNodeIds: witness.nodeIds,
    pathEdgeKinds: witness.edgeKinds,
  };
}

/**
 * The edge kinds one check may follow: membership, every grant that implies
 * `relation` (read from the ontology), and folder inheritance.
 */
function traversalAlphabet(
  store: AuthzStore,
  relation: Relation,
): Readonly<{
  grantKinds: readonly Relation[];
  edges: readonly AuthzEdgeKind[];
}> {
  const grantKinds = store.registry.expandImplyingEdges(
    relation,
  ) as readonly Relation[];
  return { grantKinds, edges: [MEMBER_OF, ...grantKinds, PARENT_OF] };
}

type PathWitness = Readonly<{
  nodeIds: readonly string[];
  edgeKinds: readonly string[];
  via: CheckVia | undefined;
}>;

async function describePath(
  store: AuthzStore,
  nodes: readonly GraphNodeRef[],
  grantKinds: readonly Relation[],
): Promise<PathWitness> {
  const nodeIds = nodes.map((node) => node.id);
  const edgeKinds: string[] = [];
  let via: CheckVia | undefined;

  for (let i = 0; i < nodes.length - 1; i++) {
    const from = nodes[i];
    const to = nodes[i + 1];
    if (from === undefined || to === undefined) continue;

    if (isSubjectKind(from.kind) && isResourceKind(to.kind)) {
      // The single subject→resource crossing: this is the grant edge.
      const relationKind = await resolveGrantKind(store, from, to, grantKinds);
      edgeKinds.push(relationKind);
      via = {
        grantSubject: from.id,
        grantRelation: relationKind,
        grantTarget: to.id,
      };
    } else if (isSubjectKind(from.kind)) {
      edgeKinds.push(MEMBER_OF);
    } else {
      edgeKinds.push(PARENT_OF);
    }
  }

  return { nodeIds, edgeKinds, via };
}

/** Which stored relation on the crossing actually satisfies the check (strongest first). */
async function resolveGrantKind(
  store: AuthzStore,
  from: GraphNodeRef,
  to: GraphNodeRef,
  grantKinds: readonly Relation[],
): Promise<Relation> {
  const granted = new Set(grantKinds);
  for (const kind of RELATION_KINDS) {
    if (granted.has(kind) && (await hasGrant(store, kind, from, to))) {
      return kind;
    }
  }
  // Unreachable: a subject→resource crossing implies a stored grant edge.
  return grantKinds[0] ?? "viewer";
}

async function hasGrant(
  store: AuthzStore,
  kind: Relation,
  from: GraphNodeRef,
  to: GraphNodeRef,
): Promise<boolean> {
  const edge = await store
    .getEdgeCollectionOrThrow(kind)
    .findByEndpoints(
      { kind: from.kind, id: from.id },
      { kind: to.kind, id: to.id },
    );
  return edge !== undefined;
}

/**
 * Resolve a `user`/`doc` query param — bare (`alice`) or full id
 * (`user:alice`) — to a node, constrained to `allowedPrefixes`. The prefix
 * allowlist is load-bearing for soundness, not ergonomics: the check's union
 * edge alphabet only computes authorization when the subject is a subject and
 * the target a resource. A full id whose prefix is not allowed (e.g. a
 * `group:` id supplied as the `doc` target) resolves to `undefined` — and the
 * routes 404 — rather than smuggling a wrong-kind node into the traversal.
 */
export async function resolveNode(
  store: AuthzStore,
  raw: string,
  allowedPrefixes: readonly string[],
): Promise<ResolvedNode | undefined> {
  const colon = raw.indexOf(":");
  if (colon !== -1) {
    const prefix = raw.slice(0, colon);
    if (!allowedPrefixes.includes(prefix)) return undefined;
    return loadNode(store, raw);
  }
  for (const prefix of allowedPrefixes) {
    const node = await loadNode(store, `${prefix}:${raw}`);
    if (node !== undefined) return node;
  }
  return undefined;
}

export async function loadNode(
  store: AuthzStore,
  id: string,
): Promise<ResolvedNode | undefined> {
  const prefix = id.split(":")[0] ?? "";
  const kind = KIND_BY_PREFIX[prefix];
  if (kind === undefined) return undefined;
  const node = await store.getNodeCollectionOrThrow(kind).getById(id);
  return node === undefined ? undefined : toResolvedNode(node);
}

/**
 * Batch-load referenced nodes, one `getByIds` per kind (not one query per
 * node), returning an id→node map. Callers preserve their own ordering by
 * mapping their ref list through the result.
 */
export async function loadNodes(
  store: AuthzStore,
  refs: readonly GraphNodeRef[],
): Promise<ReadonlyMap<string, ResolvedNode>> {
  const idsByKind = new Map<string, string[]>();
  for (const { kind, id } of refs) {
    const ids = idsByKind.get(kind) ?? [];
    ids.push(id);
    idsByKind.set(kind, ids);
  }

  const resolved = new Map<string, ResolvedNode>();
  await Promise.all(
    [...idsByKind].map(async ([kind, ids]) => {
      const nodes = await store.getNodeCollectionOrThrow(kind).getByIds(ids);
      for (const node of nodes) {
        if (node !== undefined) resolved.set(node.id, toResolvedNode(node));
      }
    }),
  );
  return resolved;
}

function toResolvedNode(node: GraphNodeRef): ResolvedNode {
  return { id: node.id, kind: node.kind, label: nameOrKind(node) };
}

/**
 * Every resource the subject can reach at each relation. The same union
 * alphabet as {@link check}: any `Folder`/`Doc` reachable outward from the
 * subject sits behind a grant that implies `relation`, so one reachability
 * sweep per relation yields the full list (widest for `viewer`, since owner
 * and editor grants imply it).
 */
export async function relationsFor(
  store: AuthzStore,
  subject: ResolvedNode,
): Promise<Record<Relation, readonly ResolvedNode[]>> {
  const entries = await Promise.all(
    RELATION_KINDS.map(
      async (relation) =>
        [relation, await reachableResources(store, subject, relation)] as const,
    ),
  );
  return Object.fromEntries(entries) as Record<
    Relation,
    readonly ResolvedNode[]
  >;
}

async function reachableResources(
  store: AuthzStore,
  subject: ResolvedNode,
  relation: Relation,
): Promise<readonly ResolvedNode[]> {
  const { edges } = traversalAlphabet(store, relation);
  const reached = await store.algorithms.reachable(subject.id, {
    edges,
    direction: "out",
    maxHops: MAX_HOPS,
    excludeSource: true,
  });
  const resources = reached.filter((node) => isResourceKind(node.kind));
  const byId = await loadNodes(store, resources);
  return resources
    .map((node) => byId.get(node.id))
    .filter((node): node is ResolvedNode => node !== undefined);
}
