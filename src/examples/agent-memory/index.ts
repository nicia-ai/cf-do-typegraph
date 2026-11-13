import { asRecordedInstant, createStoreWithSchema } from "@nicia-ai/typegraph";
import { Hono } from "hono";
import { z } from "zod";

import type { ExampleModule } from "@/examples/types";
import { aiBinding } from "@/shared/ai";

import { runAiExtraction } from "./ai";
import { agentMemoryGraph, type AgentMemoryStore } from "./graph";
import { appendMessage, replayOne, seedAll } from "./replay";
import type { ScriptStep } from "./script";
import { liveSnapshot, recordedSnapshot, timeline } from "./views";

const MAX_MESSAGE_LENGTH = 10_000;
const MAX_RECORDED_INSTANT_LENGTH = 256;
const messageSchema = z.object({
  text: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
});

const AI_DISABLED_HINT =
  "Workers AI is not enabled. Uncomment the `ai` binding in wrangler.jsonc to " +
  "use live extraction — the scripted /seed and /replay/step paths need no binding.";

export const agentMemoryExample: ExampleModule = {
  name: "agent-memory",
  description:
    "One graph per conversation: the entities and relations an agent extracts, replayable through time.",
  boot: async ({ backend, broadcast, env }) => {
    const [created] = await createStoreWithSchema(agentMemoryGraph, backend, {
      history: true,
    });
    // Swapped for the post-evolution store the first time a step grows the
    // schema; every handler reads the latest through this binding.
    let store: AgentMemoryStore = created;

    const app = new Hono();

    // Apply every remaining script step at once. Idempotent.
    app.post("/seed", async (c) => {
      const result = await seedAll(store, broadcast);
      store = result.store;
      return c.json({ applied: result.applied, total: result.total });
    });

    // Advance the conversation by exactly one message.
    app.post("/replay/step", async (c) => {
      const result = await replayOne(store, broadcast);
      store = result.store;
      return c.json({
        index: result.index,
        total: result.total,
        done: result.done,
        message: result.message,
      });
    });

    app.get("/timeline", async (c) => c.json({ steps: await timeline(store) }));

    // The current graph, or the graph as recorded at `?recorded=<instant>`.
    app.get("/graph", async (c) => {
      const recorded = c.req.query("recorded");
      if (recorded === undefined) {
        return c.json(await liveSnapshot(store));
      }
      if (recorded.length > MAX_RECORDED_INSTANT_LENGTH) {
        return c.json(
          {
            error: `\`recorded\` must be at most ${MAX_RECORDED_INSTANT_LENGTH} characters`,
          },
          400,
        );
      }
      try {
        const instant = asRecordedInstant(recorded);
        return c.json(await recordedSnapshot(store, instant));
      } catch {
        return c.json(
          { error: "`recorded` must be a `recordedAt` value from /timeline" },
          400,
        );
      }
    });

    // Opt-in Workers AI extraction over a user-supplied message.
    app.post("/messages", async (c) => {
      const body: unknown = await c.req.json().catch(() => null);
      const parsed = messageSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            error:
              "expected body { text: non-empty string up to 10000 characters }",
          },
          400,
        );
      }
      const ai = aiBinding(env);
      if (ai === undefined) {
        return c.json({ error: AI_DISABLED_HINT }, 503);
      }

      const extraction = await runAiExtraction(ai, parsed.data.text);
      const step: ScriptStep = {
        role: "user",
        text: parsed.data.text,
        mentions: extraction.mentions,
        relations: extraction.relations,
      };
      const result = await appendMessage(store, broadcast, step);
      store = result.store;
      return c.json({
        index: result.index,
        entities: extraction.mentions.length,
        relations: extraction.relations.length,
      });
    });

    return app;
  },
};
