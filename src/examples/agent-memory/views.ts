import type {
  AnyEdgeType,
  Edge,
  EdgeId,
  Node,
  NodeId,
  NodeType,
  RecordedInstant,
} from "@nicia-ai/typegraph";

import type {
  GraphSnapshot,
  SnapshotEdge,
  SnapshotNode,
} from "@/examples/types";
import {
  collectSnapshot,
  edgeSource,
  nameOrKind,
  nodeSource,
  type EdgeSource,
  type NodeSource,
} from "@/shared/snapshot";

import {
  ORGANIZATION_KIND,
  WORKS_AT_KIND,
  type AgentMemoryStore,
} from "./graph";
import type { Role } from "./script";

export type TimelineEntry = Readonly<{
  index: number;
  role: Role;
  text: string;
  recordedAt: string | null;
}>;

/**
 * The current graph. Once the schema has evolved, the runtime-added
 * Organization / worksAt kinds are pulled in through the dynamic-collection
 * escape hatch so the viz shows them alongside the compile-time kinds. The
 * bookkeeping ReplayCursor node is intentionally omitted — it is plumbing,
 * not memory.
 */
export function liveSnapshot(store: AgentMemoryStore): Promise<GraphSnapshot> {
  const nodeSources: NodeSource[] = [
    nodeSource(store.nodes.Message, (node) => `${node.role} #${node.index}`),
    nodeSource(store.nodes.Person, (node) => node.name),
    nodeSource(store.nodes.Topic, (node) => node.name),
    nodeSource(store.nodes.Place, (node) => node.name),
  ];
  const edgeSources: EdgeSource[] = [
    edgeSource(store.edges.mentions),
    edgeSource(store.edges.worksWith),
    edgeSource(store.edges.discusses),
    edgeSource(store.edges.locatedIn),
  ];

  if (store.registry.hasNodeType(ORGANIZATION_KIND)) {
    nodeSources.push(
      nodeSource(store.getNodeCollectionOrThrow(ORGANIZATION_KIND), nameOrKind),
    );
    edgeSources.push(edgeSource(store.getEdgeCollectionOrThrow(WORKS_AT_KIND)));
  }

  return collectSnapshot(nodeSources, edgeSources);
}

/**
 * The graph as it was recorded at `recorded`. The recorded-time view only
 * supports point reconstruction by id, so we enumerate the live id set and
 * rebuild each node/edge at the pinned instant — anything recorded later
 * reconstructs as `undefined` and drops out, which is exactly the "fewer
 * nodes in the past" effect.
 *
 * Extension kinds (Organization / worksAt) are excluded here: the recorded
 * view exposes no dynamic-collection accessor, so they cannot be read
 * through the pin. The live `GET /graph` shows them in full.
 */
export async function recordedSnapshot(
  store: AgentMemoryStore,
  recorded: RecordedInstant,
): Promise<GraphSnapshot> {
  const view = store.asOfRecorded(recorded);
  const [nodeGroups, edgeGroups] = await Promise.all([
    Promise.all([
      reconstructNodes(
        store.nodes.Message,
        view.nodes.Message,
        (message) => `${message.role} #${message.index}`,
      ),
      reconstructNodes(store.nodes.Person, view.nodes.Person, nameOrKind),
      reconstructNodes(store.nodes.Topic, view.nodes.Topic, nameOrKind),
      reconstructNodes(store.nodes.Place, view.nodes.Place, nameOrKind),
    ]),
    Promise.all([
      reconstructEdges(store.edges.mentions, view.edges.mentions),
      reconstructEdges(store.edges.worksWith, view.edges.worksWith),
      reconstructEdges(store.edges.discusses, view.edges.discusses),
      reconstructEdges(store.edges.locatedIn, view.edges.locatedIn),
    ]),
  ]);
  return { nodes: nodeGroups.flat(), edges: edgeGroups.flat() };
}

/** The applied messages, in order, each pinned to its recorded instant. */
export async function timeline(
  store: AgentMemoryStore,
): Promise<readonly TimelineEntry[]> {
  const messages = await store.nodes.Message.find();
  return messages
    .map((message) => ({
      index: message.index,
      role: message.role,
      text: message.text,
      recordedAt: message.recordedAt ?? null,
    }))
    .sort((a, b) => a.index - b.index);
}

async function reconstructNodes<N extends NodeType>(
  live: Readonly<{ find: () => Promise<readonly Node<N>[]> }>,
  recorded: Readonly<{
    getByIds: (
      ids: readonly NodeId<N>[],
    ) => Promise<readonly (Node<N> | undefined)[]>;
  }>,
  label: (node: Node<N>) => string,
): Promise<readonly SnapshotNode[]> {
  const ids = (await live.find()).map((node) => node.id);
  const reconstructed = await recorded.getByIds(ids);
  return reconstructed
    .filter((node): node is Node<N> => node !== undefined)
    .map((node) => ({ id: node.id, kind: node.kind, label: label(node) }));
}

async function reconstructEdges<
  E extends AnyEdgeType,
  From extends NodeType,
  To extends NodeType,
>(
  live: Readonly<{ find: () => Promise<readonly Edge<E, From, To>[]> }>,
  recorded: Readonly<{
    getByIds: (
      ids: readonly EdgeId<E>[],
    ) => Promise<readonly (Edge<E, From, To> | undefined)[]>;
  }>,
): Promise<readonly SnapshotEdge[]> {
  const ids = (await live.find()).map((edge) => edge.id);
  const reconstructed = await recorded.getByIds(ids);
  return reconstructed
    .filter((edge): edge is Edge<E, From, To> => edge !== undefined)
    .map((edge) => ({
      id: edge.id,
      kind: edge.kind,
      from: edge.fromId,
      to: edge.toId,
    }));
}
