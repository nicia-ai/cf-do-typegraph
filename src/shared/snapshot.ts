import type {
  GraphSnapshot,
  SnapshotEdge,
  SnapshotNode,
} from "@/examples/types";

type FindableNode = Readonly<{ id: string; kind: string }>;
type FindableEdge = Readonly<{
  id: string;
  kind: string;
  fromId: string;
  toId: string;
}>;

/** Reads the `name` prop off a dynamically-typed node, falling back to its kind. */
export function nameOrKind(node: Readonly<{ kind: string }>): string {
  const name = (node as Readonly<Record<string, unknown>>).name;
  return typeof name === "string" ? name : node.kind;
}

export type NodeSource = () => Promise<readonly SnapshotNode[]>;
export type EdgeSource = () => Promise<readonly SnapshotEdge[]>;

/**
 * Adapts a typed TypeGraph node collection to the snapshot wire format,
 * keeping the label function fully typed against that collection's props.
 */
export function nodeSource<N extends FindableNode>(
  collection: Readonly<{ find: () => Promise<readonly N[]> }>,
  label: (node: N) => string,
): NodeSource {
  return async () =>
    (await collection.find()).map((node) => ({
      id: node.id,
      kind: node.kind,
      label: label(node),
    }));
}

export function edgeSource<E extends FindableEdge>(
  collection: Readonly<{ find: () => Promise<readonly E[]> }>,
): EdgeSource {
  return async () =>
    (await collection.find()).map((edge) => ({
      id: edge.id,
      kind: edge.kind,
      from: edge.fromId,
      to: edge.toId,
    }));
}

/**
 * Builds the full-graph snapshot the viz consumes. Sources run
 * concurrently; each example lists its own collections so the helper
 * stays ignorant of any particular graph definition.
 */
export async function collectSnapshot(
  nodes: readonly NodeSource[],
  edges: readonly EdgeSource[],
): Promise<GraphSnapshot> {
  const [nodeGroups, edgeGroups] = await Promise.all([
    Promise.all(nodes.map((source) => source())),
    Promise.all(edges.map((source) => source())),
  ]);
  return { nodes: nodeGroups.flat(), edges: edgeGroups.flat() };
}
