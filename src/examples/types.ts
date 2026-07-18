import type { GraphBackend } from "@nicia-ai/typegraph";
import type { Hono } from "hono";

/**
 * The wire format the shared viz page consumes from `GET /graph`.
 */
export type SnapshotNode = Readonly<{
  id: string;
  kind: string;
  label: string;
}>;
export type SnapshotEdge = Readonly<{
  id: string;
  kind: string;
  from: string;
  to: string;
}>;
export type GraphSnapshot = Readonly<{
  nodes: readonly SnapshotNode[];
  edges: readonly SnapshotEdge[];
}>;

/**
 * Pushed to every live WebSocket after a mutation; the viz refetches the
 * snapshot on receipt rather than applying deltas.
 */
export type GraphChangeEvent = Readonly<{ type: "graph-changed" }>;
export const GRAPH_CHANGED: GraphChangeEvent = { type: "graph-changed" };
export type Broadcast = (event: GraphChangeEvent) => void;

export type ExampleBootContext = Readonly<{
  /** TypeGraph backend over this tenant's own Durable Object SQLite. */
  backend: GraphBackend;
  env: Env;
  tenant: string;
  broadcast: Broadcast;
}>;

/**
 * One demo example = one graph definition + one HTTP surface. The Durable
 * Object boots the module lazily on first request and keeps it for the
 * instance's lifetime. Every example app must serve `GET /graph`
 * (a {@link GraphSnapshot}) and `POST /seed` (idempotent demo data).
 */
export type ExampleModule = Readonly<{
  name: string;
  description: string;
  boot: (context: ExampleBootContext) => Promise<Hono>;
}>;
