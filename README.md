# TypeGraph on Cloudflare Durable Objects

**A graph database per user, per agent, per document — [TypeGraph](https://typegraph.dev) turns one Durable Object class into an isolated, SQLite-backed typed graph, addressed by name.** No control plane, no provisioning API, no `WHERE tenant_id`. `env.GRAPH_DO.idFromName("authz:acme")` _is_ the provisioning step — that tenant's graph materializes at the edge on first request and hibernates when idle.

Cloudflare never shipped a managed graph database. It turns out it didn't have to: a Durable Object is already a private, single-threaded SQLite database with a name, and TypeGraph turns that SQLite into a typed property graph with edges, an ontology, recursive traversal, bitemporal history, and FTS5 full-text search. This repo is three working examples of that, each running entirely on your laptop under `wrangler dev`.

```ts
// src/worker.ts — the entire multi-tenant boundary
const stub = env.GRAPH_DO.get(env.GRAPH_DO.idFromName(`${example}:${tenant}`));
return stub.fetch(request); // that tenant's graph, and nothing else, lives here
```

The tenant axis is arbitrary: per user, per agent, per conversation, per document, per project — it's whatever string you hand to `idFromName`. This repo picks three to prove the point.

## 60-second quickstart

```bash
pnpm install
pnpm dev          # wrangler dev on http://localhost:8787
```

Open <http://localhost:8787> for the landing page and the live force-directed graph viz, or drive it straight from the shell — same origin, no auth, jq not required:

> [!IMPORTANT]
> This is a local-first demo, not a production multi-tenant service. The API is
> automatically available on localhost and disabled on every other hostname by
> default. See [Deploying safely](#deploying-safely) before publishing it.

```bash
# 1. authz — a permission check IS a single graph-reachability query
curl -X POST localhost:8787/api/authz/acme/seed
curl "localhost:8787/api/authz/acme/check?user=alice&relation=editor&doc=roadmap"
# {"allowed":true,"relation":"editor","subject":"user:alice",
#  "via":{"grantSubject":"group:staff","grantRelation":"editor","grantTarget":"folder:engineering"},
#  "pathNodeIds":["user:alice","group:eng","group:staff","folder:engineering","folder:specs","doc:roadmap"],
#  "pathEdgeKinds":["memberOf","memberOf","editor","parentOf","parentOf"]}
# Alice never got a direct grant. The witness path is nested-group membership,
# one group-level editor grant, then folder inheritance — inferred, not stored.

# 2. notes — real FTS5 full-text search, running inside the Durable Object
curl -X POST localhost:8787/api/notes/me/seed
curl "localhost:8787/api/notes/me/search?q=reachability"
# {"hits":[{"id":"note:reachability","title":"Reachability","score":...,
#   "snippet":"<mark>Reachability</mark> asks whether you can get from one node to another..."}]}

# 3. agent-memory — replay a conversation, then time-travel the graph
curl -X POST localhost:8787/api/agent-memory/session-42/seed
curl "localhost:8787/api/agent-memory/session-42/timeline"
# every replayed message carries the recordedAt instant its facts landed at
curl "localhost:8787/api/agent-memory/session-42/graph?recorded=<recordedAt-of-message-4>"
# The graph re-answers "what did the agent believe after message 4" —
# bitemporal history, no snapshot tables.
```

## Three examples, three tenancy axes

The point isn't the examples — it's that they are the **same DO class**, distinguished only by the name you address it with. Each proves graph-DB-ness with a query that is painful in raw SQL.

| Example        | Tenant axis            | Star TypeGraph feature                                                |
| -------------- | ---------------------- | --------------------------------------------------------------------- |
| `agent-memory` | graph per conversation | bitemporal `as-of` replay + runtime schema evolution (`store.evolve`) |
| `authz`        | graph per workspace    | `implies` / `inverseOf` ontology + recursive reachability             |
| `notes`        | graph per user         | FTS5 full-text search + inverse-derived backlinks + shortest path     |

---

### `authz` — Zanzibar-lite, a graph per workspace

Permission checks are reachability. Subjects (`User`, `Group`) and resources (`Folder`, `Doc`) never share an edge kind except through a relation grant, so every outward path is forced into Zanzibar order — membership closure, then exactly one grant, then folder inheritance — and a check is one `shortestPath` call.

**Graph model.** `User`/`Group` `—memberOf→` `Group` (nested); `Folder` `—parentOf→` `Folder`/`Doc` (tree); relation grants `owner`/`editor`/`viewer` from a subject to a resource. The ontology does the reasoning:

```ts
// src/examples/authz/graph.ts
ontology: [
  implies(owner, editor),      // owner ⇒ editor ⇒ viewer:
  implies(editor, viewer),     //   a stronger grant satisfies a weaker check
  inverseOf(memberOf, hasMember), // read membership backwards, zero stored reverse edges
],
```

**Endpoints** (per `/api/authz/:workspace`)

- `POST /seed` — a deterministic company workspace (5 users, nested groups, a 2-deep folder tree, one group-granted editor, one direct viewer, one owner grant, and Erin — who can reach nothing).
- `GET /check?user=&relation=&doc=` — `{ allowed, via, pathNodeIds, pathEdgeKinds }`; `expandImplyingEdges` turns the requested relation into its implying grant set straight from the ontology, and the witness path comes back with every check.
- `GET /relations?user=` — every resource the user can reach, per relation — one reachability sweep each.
- `GET /members?group=` — group membership read through the **virtual** `hasMember` edge (zero stored rows; `inverseOf` resolves it).
- `GET /graph` — full snapshot for the viz.

Try the denial: `check?user=erin&relation=viewer&doc=roadmap` → `allowed:false`, empty path. Try implication: Dave has only an `owner` grant on `doc:handbook`, yet `check?user=dave&relation=viewer&doc=handbook` is allowed.

---

### `notes` — a personal knowledge graph, a graph per user

Markdown notes with `[[wiki-links]]`, backlinks, path-between-notes, and full-text search — all on one DO's SQLite. The headline: **FTS5 runs natively inside the Durable Object.** Fields marked `searchable()` are BM25-indexed and kept in sync on every write; no external search service, nothing to keep warm.

```ts
// src/examples/notes/graph.ts
export const Note = defineNode("Note", {
  schema: z.object({
    slug: z.string(),
    title: searchable({ language: "english" }), // FTS5 virtual table,
    body: searchable({ language: "english" }), //   provisioned at boot
    embedding: embedding(768).optional(), // opt-in; see Platform notes
  }),
});
```

Backlinks cost **zero stored rows**: a single `inverseOf(linksTo, linkedFrom)` relation lets a `linkedFrom` traversal follow the forward `linksTo` edges backwards, so backlinks can never drift out of sync with the links that produced them.

**Endpoints** (per `/api/notes/:user`)

- `POST /seed` — a ~11-note digital garden about graph databases, DOs, and TypeGraph itself, richly interlinked (one hub, one orphan). `{ ok, notes }`.
- `GET /search?q=` — BM25 hits with `<mark>`-highlighted snippets: `{ hits: [{ id, title, score, snippet }] }`.
- `GET /backlinks?note=` — notes linking here, via inverse traversal: `{ note, backlinks: [{ id, title }] }`.
- `GET /path?from=&to=` — shortest chain of links between two notes: `{ found, depth, pathNodeIds }`.
- `POST /notes { title, body }` — create-or-update by slug; re-parses `[[wiki-links]]`, creates missing targets as placeholders (Obsidian-style), reconciles edges. `{ id, created, linksTo }`.
- `GET /semantic?q=` — opt-in brute-force vector search (see Platform notes); `503` when the AI binding is off.
- `GET /graph` — full snapshot for the viz.

---

### `agent-memory` — an agent's memory, a graph per conversation

One conversation session = one graph. The default path replays a bundled, hand-authored conversation message-by-message — deterministic and free — extracting `Person`/`Topic`/`Place` entities and typed relations (`worksWith`, `discusses`, `locatedIn`) as it goes, broadcasting each step so the viz grows live.

Two things SQL makes you dread, both one line here:

- **Bitemporal history.** The store boots with `{ history: true }`, so `GET /graph?recorded=<instant>` re-answers "what did the agent believe after message N" without a single snapshot table.
- **Runtime schema evolution.** Mid-conversation, the script introduces an `Organization` — a node kind the compile-time schema doesn't have. That step applies a graph extension with `store.evolve(...)`, growing a new node and edge kind **while the Durable Object is live**, and the change persists and replays on the next DO wake.

```ts
// src/examples/agent-memory/index.ts
const [store] = await createStoreWithSchema(agentMemoryGraph, backend, {
  history: true, // bitemporal: store.asOfRecorded(instant) replays past belief
});
```

**Endpoints** (per `/api/agent-memory/:session`)

- `POST /seed` — replay every remaining scripted message into the graph.
- `POST /replay/step` — replay exactly one message (drive it from the viz and watch the memory grow live).
- `GET /timeline` — the applied messages with the `recordedAt` instant each one's facts landed at.
- `GET /graph` / `GET /graph?recorded=<instant>` — the snapshot now, or as the agent believed it then.
- `POST /messages { text }` — opt-in Workers AI extraction over your own message; `503` until the `ai` binding is enabled.

## How multitenancy works

There is one Durable Object class, `GraphDO`. A request to `/api/:example/:tenant/*` is forwarded to `idFromName("<example>:<tenant>")` with the identity on a header; the DO resolves which example it is, boots the matching TypeGraph store over its own `ctx.storage`, and dispatches. That's the whole boundary.

Spinning up isolated graph databases is a loop, not a project — mint 25 in one request:

```bash
curl -X POST "localhost:8787/api/spawn/notes?count=25&prefix=demo"
# {"example":"notes","seeded":["demo-1","demo-2", ... ,"demo-25"]}
curl "localhost:8787/api/notes/demo-7/search?q=hibernation"   # its own private graph
```

**Isolation is physical, not enforced.** Each tenant is a distinct Durable Object with its own SQLite file — separate tables, separate storage, no shared rows, no cross-tenant query surface to get wrong. There is no `tenant_id` column to forget in a `WHERE` clause, because there is no shared table to put one in. The blast radius of a query bug is one tenant, by construction.

## Platform notes

- **FTS5 works natively in DO SQLite.** `fts5` (and `fts5vocab`) are the allowed virtual tables, so BM25 full-text search runs inside the object with no extension to load. This surprises people; it's the `notes` example's whole premise.
- **`sqlite-vec` does not load in `workerd`** — no loadable extensions. So vector search here is **opt-in, brute-force JS cosine** over Workers AI embeddings (`@cf/baai/bge-base-en-v1.5`, 768-dim), the pattern from TypeGraph's own `examples/11`. For _indexed_ nearest-neighbour search, run the same graph on a [pgvector](https://github.com/pgvector/pgvector) (Postgres) or [libSQL](https://github.com/tursodatabase/libsql) backend — TypeGraph's vector API is backend-pluggable and unchanged.
- **Workers AI always bills.** The `ai` binding proxies to your real Cloudflare account and charges usage **even under `wrangler dev`**, so it ships commented out in [`wrangler.jsonc`](./wrangler.jsonc). Uncomment it to enable semantic search in `notes` and AI extraction in `agent-memory`; every default path works, deterministically and for free, without it.

## Deploying safely

`pnpm deploy` deploys the static site, but the Worker returns `403` for every
`/api/*` request on non-local hostnames because `ALLOW_PUBLIC_API` defaults to
`"false"`. This prevents an accidental deployment from exposing unauthenticated
Durable Object writes, WebSockets, or billable Workers AI calls.

Before changing `ALLOW_PUBLIC_API` to `"true"`:

1. Put the Worker behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/).
2. Add [Cloudflare rate limits](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) for `/api/spawn/*`, note writes, WebSockets, and Workers AI endpoints.
3. Keep the request limits in the Worker or make them stricter for your use case.
4. Treat tenant names as routing identifiers, not credentials. Physical database isolation does not authenticate callers.

See [SECURITY.md](./SECURITY.md) for private vulnerability reporting.

## Commands

| Command       | Does                                                        |
| ------------- | ----------------------------------------------------------- |
| `pnpm dev`    | `wrangler dev` on <http://localhost:8787>                   |
| `pnpm test`   | vitest suite                                                |
| `pnpm check`  | typecheck + lint + format check + test (the single CI gate) |
| `pnpm deploy` | Deploy the site; public API remains disabled by default     |

Tests run under [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/) against **real Durable Objects** — no mocks, no fakes. Each test seeds a freshly-named tenant, so isolation is exercised on every run.

## Links

- TypeGraph — <https://typegraph.dev> · [github.com/nicia-ai/typegraph](https://github.com/nicia-ai/typegraph)
- Durable Objects SQLite storage — <https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/>
- SQLite FTS5 — <https://www.sqlite.org/fts5.html>
- WebSocket Hibernation — <https://developers.cloudflare.com/durable-objects/best-practices/websockets/>
- Workers AI — <https://developers.cloudflare.com/workers-ai/>

## License

MIT © 2026 [Nicia AI, Inc.](https://nicia.ai). See [LICENSE](./LICENSE).
