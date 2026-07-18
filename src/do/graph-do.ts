import { createSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite";
import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import type { Hono } from "hono";

import { EXAMPLES, isExampleName, type ExampleName } from "@/examples/registry";
import type { GraphChangeEvent } from "@/examples/types";
import { GRAPH_EXAMPLE_HEADER, GRAPH_TENANT_HEADER } from "@/shared/routing";

const IDENTITY_KEY = "graph-do:identity";

type Identity = Readonly<{ example: ExampleName; tenant: string }>;

/**
 * The whole demo in one class: every tenant of every example is an
 * instance of GraphDO, addressed as `idFromName("<example>:<tenant>")`.
 * Each instance owns a private SQLite database that TypeGraph turns into
 * a graph store on first request.
 *
 * Identity (which example, which tenant) arrives on forwarded request
 * headers and is persisted so hibernation wake-ups that start with a
 * WebSocket event still know who they are.
 */
export class GraphDO extends DurableObject<Env> {
  private identity?: Identity;
  private app: Promise<Hono> | undefined;

  override async fetch(request: Request): Promise<Response> {
    const identity = await this.resolveIdentity(request);
    if (identity === undefined) {
      return Response.json(
        { error: "GraphDO reached without example/tenant identity" },
        { status: 400 },
      );
    }

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const app = await this.ensureApp(identity);
    return app.fetch(request, this.env);
  }

  override webSocketMessage(
    ws: WebSocket,
    message: ArrayBuffer | string,
  ): void {
    // The viz only listens; answer pings so intermediaries keep the
    // socket alive, ignore everything else.
    if (message === "ping") ws.send("pong");
  }

  override webSocketClose(): void {
    // Hibernation API tracks sockets; nothing to clean up.
  }

  override webSocketError(): void {
    // Dropped peers are removed from getWebSockets() automatically.
  }

  private async resolveIdentity(
    request: Request,
  ): Promise<Identity | undefined> {
    if (this.identity !== undefined) return this.identity;

    const example = request.headers.get(GRAPH_EXAMPLE_HEADER);
    const tenant = request.headers.get(GRAPH_TENANT_HEADER);
    if (example !== null && tenant !== null && isExampleName(example)) {
      this.identity = { example, tenant };
      await this.ctx.storage.put(IDENTITY_KEY, this.identity);
      return this.identity;
    }

    const stored = await this.ctx.storage.get<Identity>(IDENTITY_KEY);
    if (stored !== undefined) this.identity = stored;
    return stored;
  }

  private ensureApp(identity: Identity): Promise<Hono> {
    this.app ??= EXAMPLES[identity.example]
      .boot({
        backend: createSqliteBackend(drizzle(this.ctx.storage)),
        env: this.env,
        tenant: identity.tenant,
        broadcast: this.broadcast,
      })
      .catch((error: unknown) => {
        // A failed boot must not poison the instance: drop the memo so the
        // next request retries from a clean slate instead of re-awaiting
        // the same rejected promise until the DO is evicted.
        this.app = undefined;
        throw error;
      });
    return this.app;
  }

  private readonly broadcast = (event: GraphChangeEvent): void => {
    const payload = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Peer already gone; the hibernation API prunes it.
      }
    }
  };
}
