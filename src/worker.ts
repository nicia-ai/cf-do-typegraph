import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import {
  EXAMPLE_NAMES,
  EXAMPLES,
  isExampleName,
  type ExampleName,
} from "@/examples/registry";
import {
  doName,
  GRAPH_EXAMPLE_HEADER,
  GRAPH_TENANT_HEADER,
} from "@/shared/routing";

export { GraphDO } from "@/do/graph-do";

const SPAWN_MAX = 200;
const SPAWN_DEFAULT = 10;
const MAX_BODY_BYTES = 128 * 1024;
const LOCAL_API_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Tenant names become DO names, header values, and URL segments, so they
// are restricted to a charset that is valid in all three. Spawn prefixes
// get a numeric suffix appended, hence the shorter cap.
const TENANT_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const PREFIX_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;

const app = new Hono<{ Bindings: Env }>();

// This repository is a local demo, not an unauthenticated public service.
// A production deployment must explicitly opt in after putting the Worker
// behind access control and rate limiting (see README.md).
app.use("/api/*", async (c, next) => {
  const hostname = new URL(c.req.url).hostname;
  if (
    LOCAL_API_HOSTS.has(hostname) ||
    c.env.ALLOW_PUBLIC_API.toLowerCase() === "true"
  ) {
    await next();
    return;
  }
  return c.json(
    {
      error:
        "public API disabled; protect the Worker first, then set ALLOW_PUBLIC_API=true",
    },
    403,
  );
});

app.use(
  "/api/*",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: "request body exceeds 128 KiB" }, 413),
  }),
);

// Every surface answers JSON, but internal exception details stay in logs.
app.onError((error, c) => {
  console.error("unhandled request error", error);
  return c.json({ error: "internal server error" }, 500);
});

app.get("/api/examples", (c) =>
  c.json({
    examples: EXAMPLE_NAMES.map((name) => ({
      name,
      description: EXAMPLES[name].description,
    })),
  }),
);

// The money shot: mint N isolated graph databases in one request. Each
// tenant is a fresh Durable Object with its own SQLite-backed graph.
app.post("/api/spawn/:example", async (c) => {
  const example = c.req.param("example");
  if (!isExampleName(example)) {
    return c.json({ error: `unknown example: ${example}` }, 404);
  }
  const prefix = c.req.query("prefix") ?? "demo";
  if (!PREFIX_PATTERN.test(prefix)) {
    return c.json({ error: "prefix must match [A-Za-z0-9._-]{1,32}" }, 400);
  }
  const requested = Number(c.req.query("count") ?? SPAWN_DEFAULT);
  const count = Number.isInteger(requested)
    ? Math.min(Math.max(requested, 1), SPAWN_MAX)
    : SPAWN_DEFAULT;
  const tenants = Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);

  const outcomes = await Promise.allSettled(
    tenants.map(async (tenant) => {
      const response = await forwardToTenant(
        c.env,
        example,
        tenant,
        new Request("https://do/seed", { method: "POST" }),
      );
      if (!response.ok) {
        throw new Error(`seed returned ${response.status}`);
      }
    }),
  );

  const seeded: string[] = [];
  const failed: { tenant: string; error: string }[] = [];
  outcomes.forEach((outcome, i) => {
    const tenant = tenants[i] ?? `${prefix}-${i + 1}`;
    if (outcome.status === "fulfilled") {
      seeded.push(tenant);
    } else {
      failed.push({ tenant, error: String(outcome.reason) });
    }
  });

  return c.json({ example, seeded, failed }, seeded.length > 0 ? 200 : 502);
});

app.all("/api/:example/:tenant", (c) => forwardFromRoute(c));
app.all("/api/:example/:tenant/*", (c) => forwardFromRoute(c));

function forwardFromRoute(
  c: Context<{ Bindings: Env }>,
): Response | Promise<Response> {
  const example = c.req.param("example") ?? "";
  const tenant = c.req.param("tenant") ?? "";
  if (!isExampleName(example)) {
    return c.json({ error: `unknown example: ${example}` }, 404);
  }
  if (!TENANT_PATTERN.test(tenant)) {
    return c.json({ error: "tenant must match [A-Za-z0-9._-]{1,64}" }, 400);
  }

  // Rebuild the forwarded path from the RAW pathname segments rather than
  // slicing by decoded param lengths — percent-encoded tenant names would
  // otherwise shift the offset and forward to a garbage path.
  const url = new URL(c.req.url);
  const rest = url.pathname.split("/").slice(4).join("/");
  url.pathname = `/${rest}`;

  return forwardToTenant(
    c.env,
    example,
    tenant,
    new Request(url.toString(), c.req.raw),
  );
}

/**
 * The whole multi-tenant boundary: a tenant's graph database is the DO
 * instance named by {@link doName}, and nothing else ever routes there.
 */
function forwardToTenant(
  env: Env,
  example: ExampleName,
  tenant: string,
  request: Request,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set(GRAPH_EXAMPLE_HEADER, example);
  headers.set(GRAPH_TENANT_HEADER, tenant);
  const stub = env.GRAPH_DO.get(
    env.GRAPH_DO.idFromName(doName(example, tenant)),
  );
  return stub.fetch(new Request(request, { headers }));
}

export default app;
