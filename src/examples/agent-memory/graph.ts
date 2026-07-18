import {
  defineEdge,
  defineGraph,
  defineNode,
  type HistoryStore,
} from "@nicia-ai/typegraph";
import { z } from "zod";

/**
 * One conversation session = one graph. Messages are the ledger the replay
 * walks; Person / Topic / Place are the entities an agent extracts from them.
 * Organization is deliberately absent — it arrives at runtime through a graph
 * extension mid-conversation, proving the schema can grow while the DO is live.
 */

export const Message = defineNode("Message", {
  schema: z.object({
    index: z.number().int().positive(),
    role: z.enum(["user", "assistant"]),
    text: z.string(),
    // Stamped after the write commits with `store.recordedNow()`, so the
    // timeline can pin each message to the instant its facts were recorded.
    recordedAt: z.string().optional(),
  }),
});

export const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

export const Topic = defineNode("Topic", {
  schema: z.object({ name: z.string() }),
});

export const Place = defineNode("Place", {
  schema: z.object({ name: z.string() }),
});

/**
 * A singleton bookkeeping node (`id: "cursor"`) recording how many script
 * steps have been replayed. Kept in the graph itself so replay progress
 * survives DO hibernation exactly like the memory it drives.
 */
export const ReplayCursor = defineNode("ReplayCursor", {
  schema: z.object({ applied: z.number().int().nonnegative() }),
});

const mentions = defineEdge("mentions", { schema: z.object({}) });
const worksWith = defineEdge("worksWith", { schema: z.object({}) });
const discusses = defineEdge("discusses", { schema: z.object({}) });
const locatedIn = defineEdge("locatedIn", { schema: z.object({}) });

export const agentMemoryGraph = defineGraph({
  id: "agent_memory",
  nodes: {
    Message: { type: Message },
    Person: { type: Person },
    Topic: { type: Topic },
    Place: { type: Place },
    ReplayCursor: { type: ReplayCursor },
  },
  edges: {
    mentions: { type: mentions, from: [Message], to: [Person, Topic, Place] },
    worksWith: { type: worksWith, from: [Person], to: [Person] },
    discusses: { type: discusses, from: [Person], to: [Topic] },
    locatedIn: { type: locatedIn, from: [Person], to: [Place] },
  },
});

/**
 * The store type this example threads everywhere. `history: true` gives it
 * the recorded-time surface (`recordedNow`, `asOfRecorded`) the replay uses.
 */
export type AgentMemoryStore = HistoryStore<typeof agentMemoryGraph>;

export const CURSOR_ID = "cursor";

/** Node/edge kinds introduced at runtime by the mid-script graph extension. */
export const ORGANIZATION_KIND = "Organization";
export const WORKS_AT_KIND = "worksAt";

export function messageId(index: number): string {
  return `message:${index}`;
}
