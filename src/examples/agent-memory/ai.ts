import { z } from "zod";

import type { AiRunner } from "@/shared/ai";
import { slugify } from "@/shared/slug";

import type { EntityKind, Mention, Relation, RelationKind } from "./script";

/**
 * The opt-in path: extraction by a small Workers AI model instead of the
 * hand-authored script. It is strictly secondary — the default demo never
 * calls it — so it degrades to "extracted nothing" rather than throwing on a
 * malformed model reply.
 */

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

const KIND_PREFIX: Readonly<Record<EntityKind, string>> = {
  Person: "person",
  Topic: "topic",
  Place: "place",
};

const RELATION_ENDPOINTS: Readonly<
  Record<RelationKind, Readonly<{ from: EntityKind; to: EntityKind }>>
> = {
  worksWith: { from: "Person", to: "Person" },
  discusses: { from: "Person", to: "Topic" },
  locatedIn: { from: "Person", to: "Place" },
};

const extractionSchema = z.object({
  entities: z
    .array(
      z.object({
        kind: z.enum(["Person", "Topic", "Place"]),
        name: z.string().min(1),
      }),
    )
    .default([]),
  relations: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        kind: z.enum(["worksWith", "discusses", "locatedIn"]),
      }),
    )
    .default([]),
});

export type Extraction = Readonly<{
  mentions: readonly Mention[];
  relations: readonly Relation[];
}>;

export async function runAiExtraction(
  ai: AiRunner,
  text: string,
): Promise<Extraction> {
  const prompt = [
    "You extract a small knowledge graph from a single chat message.",
    "Reply with STRICT JSON only, no prose, matching:",
    '{"entities":[{"kind":"Person|Topic|Place","name":"..."}],',
    ' "relations":[{"from":"<entity name>","to":"<entity name>","kind":"worksWith|discusses|locatedIn"}]}',
    "worksWith links two People, discusses links a Person to a Topic, locatedIn links a Person to a Place.",
    `Message: ${text}`,
  ].join("\n");

  const output = await ai.run(MODEL, { prompt, max_tokens: 512 });
  const parsed = extractionSchema.safeParse(
    parseJsonObject(responseText(output)),
  );
  if (!parsed.success) return { mentions: [], relations: [] };

  const mentionByName = new Map<string, Mention>();
  const mentions: Mention[] = [];
  for (const entity of parsed.data.entities) {
    const id = `${KIND_PREFIX[entity.kind]}:${slugify(entity.name)}`;
    if (id.endsWith(":")) continue;
    const key = entity.name.toLowerCase();
    if (!mentionByName.has(key)) {
      const mention: Mention = { kind: entity.kind, id, name: entity.name };
      mentionByName.set(key, mention);
      mentions.push(mention);
    }
  }

  const relations: Relation[] = [];
  for (const relation of parsed.data.relations) {
    const from = mentionByName.get(relation.from.toLowerCase());
    const to = mentionByName.get(relation.to.toLowerCase());
    const endpoints = RELATION_ENDPOINTS[relation.kind];
    if (
      from !== undefined &&
      to !== undefined &&
      from.kind === endpoints.from &&
      to.kind === endpoints.to
    ) {
      relations.push({ kind: relation.kind, from: from.id, to: to.id });
    }
  }

  return { mentions, relations };
}

function responseText(output: unknown): string {
  if (
    output !== null &&
    typeof output === "object" &&
    "response" in output &&
    typeof (output as Readonly<{ response: unknown }>).response === "string"
  ) {
    return (output as Readonly<{ response: string }>).response;
  }
  return "";
}

function parseJsonObject(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
