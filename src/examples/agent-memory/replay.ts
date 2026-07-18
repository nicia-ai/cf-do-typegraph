import {
  asNodeId,
  validateGraphExtension,
  type TransactionContext,
} from "@nicia-ai/typegraph";

import { GRAPH_CHANGED, type Broadcast } from "@/examples/types";

import {
  type agentMemoryGraph,
  CURSOR_ID,
  messageId,
  ORGANIZATION_KIND,
  type ReplayCursor,
  WORKS_AT_KIND,
  type AgentMemoryStore,
} from "./graph";
import {
  SCRIPT,
  type Evolution,
  type Mention,
  type ScriptStep,
} from "./script";

type TxContext = TransactionContext<typeof agentMemoryGraph>;

export type SeedResult = Readonly<{
  store: AgentMemoryStore;
  applied: number;
  total: number;
}>;

export type StepResult = Readonly<{
  store: AgentMemoryStore;
  index: number;
  total: number;
  done: boolean;
  message: string;
}>;

/** Reads the singleton replay cursor — how many script steps have landed. */
export async function readCursor(store: AgentMemoryStore): Promise<number> {
  const cursor = await store.nodes.ReplayCursor.getById(
    asNodeId<typeof ReplayCursor>(CURSOR_ID),
  );
  return cursor?.applied ?? 0;
}

/** Applies every not-yet-replayed step. Idempotent once the script is exhausted. */
export async function seedAll(
  store: AgentMemoryStore,
  broadcast: Broadcast,
): Promise<SeedResult> {
  const total = SCRIPT.length;
  const start = await readCursor(store);
  let current = store;
  let index = start;
  for (const step of SCRIPT.slice(start)) {
    current = await applyStep(current, step, index);
    index += 1;
  }
  const applied = total - start;
  // One logical mutation → one broadcast: a connected viz refetches once for a
  // full seed, not once per replayed step. The step-animation paths
  // (replayOne / appendMessage) keep their per-message broadcast.
  if (applied > 0) broadcast(GRAPH_CHANGED);
  return { store: current, applied, total };
}

/** Applies exactly one step, or reports the script already fully replayed. */
export async function replayOne(
  store: AgentMemoryStore,
  broadcast: Broadcast,
): Promise<StepResult> {
  const total = SCRIPT.length;
  const start = await readCursor(store);
  const step = SCRIPT.at(start);
  if (step === undefined) {
    return { store, index: total, total, done: true, message: "" };
  }
  const next = await applyStep(store, step, start);
  const index = start + 1;
  broadcast(GRAPH_CHANGED);
  return {
    store: next,
    index,
    total,
    done: index >= total,
    message: step.text,
  };
}

/**
 * Appends a message the script did not author (the opt-in Workers AI path).
 *
 * Appended messages live OUTSIDE the script's index space and never move the
 * replay cursor, so an AI message can never shadow an unreplayed scripted step
 * (the evolution step included). Their number continues past the script:
 * `SCRIPT.length + <messages already appended> + 1`, where the appended count
 * is derived from the graph (total messages minus the replayed-script count)
 * rather than kept in memory, so it survives DO hibernation. Timeline still
 * orders by index, so appended messages sort after the script.
 */
export async function appendMessage(
  store: AgentMemoryStore,
  broadcast: Broadcast,
  step: ScriptStep,
): Promise<Readonly<{ store: AgentMemoryStore; index: number }>> {
  const replayed = await readCursor(store);
  const messages = await store.nodes.Message.count();
  const number = SCRIPT.length + (messages - replayed) + 1;
  const next = await writeMessage(store, step, number);
  broadcast(GRAPH_CHANGED);
  return { store: next, index: number };
}

/** A scripted step, applied at its script position, advancing the cursor. */
async function applyStep(
  store: AgentMemoryStore,
  step: ScriptStep,
  index: number,
): Promise<AgentMemoryStore> {
  const number = index + 1;
  const current = await writeMessage(store, step, number);
  await writeCursor(current, number);
  return current;
}

/**
 * Writes one message and everything it introduced, at the given message
 * number, then stamps the message with the instant its facts were recorded.
 *
 * The message, the entities it introduced, and their edges land in a single
 * transaction; an optional schema evolution and the recorded-instant stamp
 * follow as their own commits. Every write is idempotent — `upsertById` for the
 * message, `ensureEntity` for entities, `getOrCreateByEndpoints` for edges, and
 * a guarded evolve — so a step interrupted between those commits (a crash, or a
 * DO eviction) completes on re-run instead of erroring on a duplicate. Returns
 * the store to use next — the same instance, unless the step evolved the schema,
 * in which case it is the new post-evolution store.
 */
async function writeMessage(
  store: AgentMemoryStore,
  step: ScriptStep,
  number: number,
): Promise<AgentMemoryStore> {
  const id = messageId(number);

  await store.transaction(async (tx) => {
    await tx.nodes.Message.upsertById(id, {
      index: number,
      role: step.role,
      text: step.text,
    });
    for (const mention of step.mentions) {
      await ensureEntity(tx, mention);
      await tx.edges.mentions.getOrCreateByEndpoints(
        { kind: "Message", id },
        { kind: mention.kind, id: mention.id },
        {},
      );
    }
    for (const relation of step.relations) {
      await createRelation(tx, relation);
    }
  });

  const current = step.evolution
    ? await applyEvolution(store, step.evolution)
    : store;

  // `recordedNow()` is the high-water mark after the writes committed; pinning
  // it onto the message lets `GET /graph?recorded=<instant>` replay "what the
  // agent believed after this message."
  const instant = await current.recordedNow();
  if (instant !== undefined) {
    await current
      .getNodeCollectionOrThrow("Message")
      .update(id, { recordedAt: String(instant) });
  }
  return current;
}

/** Idempotently materializes an entity node the way an extractor would. */
async function ensureEntity(tx: TxContext, mention: Mention): Promise<void> {
  const collection = tx.getNodeCollection(mention.kind);
  if (collection === undefined) {
    throw new Error(`unknown entity kind: ${mention.kind}`);
  }
  const existing = await collection.getById(mention.id);
  if (existing === undefined) {
    await collection.create({ name: mention.name }, { id: mention.id });
  }
}

async function createRelation(
  tx: TxContext,
  relation: ScriptStep["relations"][number],
): Promise<void> {
  // Each (kind, from, to) triple is unique across the script, so an
  // endpoint-keyed get-or-create is both the right semantics and idempotent
  // under replay retries.
  switch (relation.kind) {
    case "worksWith":
      await tx.edges.worksWith.getOrCreateByEndpoints(
        { kind: "Person", id: relation.from },
        { kind: "Person", id: relation.to },
        {},
      );
      return;
    case "discusses":
      await tx.edges.discusses.getOrCreateByEndpoints(
        { kind: "Person", id: relation.from },
        { kind: "Topic", id: relation.to },
        {},
      );
      return;
    case "locatedIn":
      await tx.edges.locatedIn.getOrCreateByEndpoints(
        { kind: "Person", id: relation.from },
        { kind: "Place", id: relation.to },
        {},
      );
      return;
  }
}

/**
 * The showcase moment. Untrusted-shaped JSON is validated, then `evolve`
 * atomically commits a new schema version and returns a store carrying the
 * new kinds. We create the Organization nodes and worksAt edges through the
 * dynamic collection escape hatch, since the new kinds are invisible to the
 * compile-time type system.
 *
 * Resumable: the `evolve` is guarded on whether the kind already exists, so a
 * retry after a mid-step crash (or a DO restart, where `createStoreWithSchema`
 * has already folded the persisted extension back in) skips straight to the
 * idempotent data writes instead of re-evolving.
 */
async function applyEvolution(
  store: AgentMemoryStore,
  evolution: Evolution,
): Promise<AgentMemoryStore> {
  let current = store;
  if (!current.registry.hasNodeType(ORGANIZATION_KIND)) {
    const validation = validateGraphExtension(evolution.extension, {
      strict: true,
    });
    if (!validation.success) throw validation.error;

    current = await current.evolve(validation.data);
  }

  const organizations = current.getNodeCollectionOrThrow(ORGANIZATION_KIND);
  for (const organization of evolution.organizations) {
    await organizations.upsertById(organization.id, {
      name: organization.name,
    });
  }

  const worksAt = current.getEdgeCollectionOrThrow(WORKS_AT_KIND);
  for (const employment of evolution.employments) {
    await worksAt.getOrCreateByEndpoints(
      { kind: "Person", id: employment.person },
      { kind: ORGANIZATION_KIND, id: employment.org },
      {},
    );
  }
  return current;
}

async function writeCursor(
  store: AgentMemoryStore,
  applied: number,
): Promise<void> {
  await store.getNodeCollectionOrThrow("ReplayCursor").upsertById(CURSOR_ID, {
    applied,
  });
}
