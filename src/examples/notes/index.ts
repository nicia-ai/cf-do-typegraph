import { createStoreWithSchema } from "@nicia-ai/typegraph";
import { Hono } from "hono";
import { z } from "zod";

import { GRAPH_CHANGED, type ExampleModule } from "@/examples/types";
import { aiBinding } from "@/shared/ai";
import { collectSnapshot, edgeSource, nodeSource } from "@/shared/snapshot";

import { notesGraph } from "./graph";
import { createNotesOperations } from "./operations";
import { seedGarden } from "./seed";

const AI_DISABLED_MESSAGE =
  "Semantic search needs the opt-in Workers AI binding. Enable the `ai` binding in wrangler.jsonc to embed notes and queries.";

const noteInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(100_000),
});
const searchQuerySchema = z.string().max(1_000);
const noteReferenceSchema = z.string().max(200);

export const notesExample: ExampleModule = {
  name: "notes",
  description:
    "One graph per user: wiki-linked notes with backlinks and FTS5 full-text search.",
  boot: async ({ backend, env, broadcast }) => {
    const [store] = await createStoreWithSchema(notesGraph, backend);
    const operations = createNotesOperations(store, aiBinding(env));
    const app = new Hono();

    app.get("/graph", async (c) =>
      c.json(
        await collectSnapshot(
          [nodeSource(store.nodes.Note, (node) => node.title)],
          [edgeSource(store.edges.linksTo)],
        ),
      ),
    );

    app.post("/seed", async (c) => {
      const notes = await seedGarden(operations);
      broadcast(GRAPH_CHANGED);
      return c.json({ ok: true, notes });
    });

    app.get("/search", async (c) => {
      const parsed = searchQuerySchema.safeParse(c.req.query("q") ?? "");
      if (!parsed.success) {
        return c.json({ error: "q must be at most 1000 characters" }, 400);
      }
      const query = parsed.data;
      if (query.trim() === "") return c.json({ hits: [] });
      return c.json({ hits: await operations.searchNotes(query) });
    });

    app.get("/backlinks", async (c) => {
      const parsed = noteReferenceSchema.safeParse(c.req.query("note") ?? "");
      if (!parsed.success) {
        return c.json({ error: "note must be at most 200 characters" }, 400);
      }
      const note = parsed.data;
      const backlinks = await operations.backlinksOf(note);
      return c.json({ note, backlinks });
    });

    app.get("/path", async (c) => {
      const fromParsed = noteReferenceSchema.safeParse(
        c.req.query("from") ?? "",
      );
      const toParsed = noteReferenceSchema.safeParse(c.req.query("to") ?? "");
      if (!fromParsed.success || !toParsed.success) {
        return c.json(
          { error: "from and to must each be at most 200 characters" },
          400,
        );
      }
      const from = fromParsed.data;
      const to = toParsed.data;
      return c.json(await operations.shortestPathBetween(from, to));
    });

    app.post("/notes", async (c) => {
      const body: unknown = await c.req.json().catch(() => null);
      const parsed = noteInputSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            error:
              "expected title (1-200 characters) and body (up to 100000 characters)",
          },
          400,
        );
      }
      const outcome = await operations.writeNote(
        parsed.data.title,
        parsed.data.body,
      );
      if (!outcome.ok) return c.json({ error: outcome.error }, 400);
      broadcast(GRAPH_CHANGED);
      return c.json(outcome.result);
    });

    app.get("/semantic", async (c) => {
      if (!operations.semanticEnabled()) {
        return c.json({ error: AI_DISABLED_MESSAGE }, 503);
      }
      const parsed = searchQuerySchema.safeParse(c.req.query("q") ?? "");
      if (!parsed.success) {
        return c.json({ error: "q must be at most 1000 characters" }, 400);
      }
      const query = parsed.data;
      if (query.trim() === "") return c.json({ hits: [] });
      return c.json({ hits: await operations.semanticSearch(query) });
    });

    return app;
  },
};
