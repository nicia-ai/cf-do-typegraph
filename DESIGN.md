# Design: TypeGraph on Cloudflare Durable Objects

A demo repo showing that **one Durable Object class + TypeGraph = a graph
database per tenant**, with tenancy as a routing decision rather than an
infrastructure project. Runs entirely locally with `wrangler dev`; no
signup, no keys required (Workers AI is opt-in).

## The pitch

- `idFromName("authz:acme")` → a whole private graph DB materializes at
  the edge. No provisioning, no row-level security, no `WHERE tenant_id`.
- Each example proves graph-DB-ness with queries painful in raw SQL:
  ontology inference, recursive reachability, bitemporal replay,
  full-text search over graph nodes (FTS5 — supported natively in DO
  SQLite).

## Tenancy model

```
/:example/:tenant/*  →  DO instance idFromName(`${example}:${tenant}`)
```

Three examples, three tenancy axes:

| Example        | Tenant axis         | Star features                                       |
| -------------- | ------------------- | --------------------------------------------------- |
| `agent-memory` | graph per session   | bitemporal replay, live WS viz, opt-in Workers AI   |
| `authz`        | graph per workspace | `implies`/`inverseOf` ontology, reachability checks |
| `notes`        | graph per user      | FTS5 fulltext search, backlinks, path-between-notes |

## Architecture

```
src/
  worker.ts               Entry: routes /api/:example/:tenant/* to the DO
  do/
    graph-do.ts           GraphDO — the single DO class for all examples:
                          learns its identity from forwarded headers, boots
                          the right TypeGraph store over ctx.storage,
                          dispatches to example routes, broadcasts mutations
                          to hibernatable WebSockets
  examples/
    types.ts              ExampleModule contract + snapshot/event wire types
    registry.ts           name → module map; the worker's routing source
    <name>/
      graph.ts            defineNode/defineEdge/defineGraph (+ ontology)
      index.ts            boot (createStoreWithSchema) + Hono routes
      …                   example-specific modules (seed, script, check, …)
  shared/
    routing.ts            worker↔DO headers + the doName() tenancy scheme
    snapshot.ts           Whole-graph export (nodes + edges) for the viz
    slug.ts ai.ts         Cross-example helpers
public/
  index.html              Landing: example/tenant picker
  viz.html                Shared force-directed viz (WS live + snapshot),
                          time slider for agent-memory temporal replay
test/                     vitest-pool-workers e2e per example +
                          cross-tenant isolation test
```

### Key platform facts (verified 2026-07)

- DO SQLite supports FTS5 (`fts5`/`fts5vocab` are the only allowed
  virtual tables). No sqlite-vec / vec0, no loadable extensions.
- Workers AI bindings always proxy to the real account and bill, even
  under `wrangler dev` — so AI extraction in `agent-memory` is strictly
  opt-in through the commented-out binding; the default path is a scripted
  conversation replay.
- WebSocket Hibernation: `ctx.acceptWebSocket(ws)`, class-level
  `webSocketMessage/Close/Error`, and `ctx.getWebSockets()`.

### TypeGraph wiring (verified against source)

- Backend: `drizzle(ctx.storage)` (`drizzle-orm/durable-sqlite`) →
  `createSqliteBackend(db)` from `@nicia-ai/typegraph/adapters/drizzle/sqlite`.
  DO mode is auto-detected; transactions map to `ctx.storage.transaction`.
- Boot: `createStoreWithSchema(graph, backend, options)` — required on a
  fresh DO (runs DDL incl. fulltext tables); `createStore` is attach-only.
- Fulltext: `searchable()` fields; `store.search.fulltext(kind, {query})`
  and node-level `p.$fulltext.matches(...)` in the query builder.
- Ontology: `ontology: [implies(editor, viewer), inverseOf(memberOf, hasMember), subClassOf(...)]`
  on `defineGraph`. Traversal expansion is opt-in: `{ expand: "implying" }`;
  `inverseOf` resolves automatically.
- Bitemporal: `createStoreWithSchema(..., { history: true })`;
  `store.asOf(validAt)` / `store.asOfRecorded(recordedInstant)`;
  recorded instants come from `store.recordedNow()`.
- Algorithms: `store.algorithms.shortestPath/reachable/canReach/neighbors/degree`
  (`WITH RECURSIVE` CTEs; options `{ edges, maxHops, direction }`).
- Variable-depth traversal: `.traverse("edge", "e").recursive({ minHops, maxHops, depth: "distance", path: "route" })`.
- Runtime extensions: `defineGraphExtension(json)` /
  `validateGraphExtension(raw, { strict: true })` for untrusted LLM JSON →
  `store.evolve(ext)` returns a new store; extension persists in the
  schema doc and replays on DO restart via `createStoreWithSchema`.
- Indexed vector search is not available on DO SQLite (it needs
  sqlite-vec/libSQL). The notes demo stores Workers AI embeddings and uses a
  deliberately brute-force JavaScript cosine ranking fallback.

## Example specs

### agent-memory — graph per conversation

Entities (`Person`, `Place`, `Topic`, …) and typed relations extracted
from a conversation, one DO per session id. Default: a bundled scripted
conversation replayed message-by-message (deterministic, free); each
replay step writes to the graph and broadcasts over WS so the viz grows
live. `history: true` lets `GET .../graph?recorded=<t>` re-answer "what
did the agent believe after message N" — each message's recorded instant
is kept on the Message node. Optional: enabling the `ai` binding activates
the `/messages` endpoint, which uses Workers AI (a small Llama model) over
user-supplied messages.

### authz — graph per workspace

Zanzibar-lite. Nodes: `User`, `Group`, `Folder`, `Doc`. Edges:
`memberOf` (inverse `hasMember`), `parentOf` (folder tree), relation
edges `owner`/`editor`/`viewer` with ontology
`implies(owner, editor), implies(editor, viewer)`.
`GET .../check?user=u&relation=viewer&doc=d` answers via traversal with
`{ expand: "implying" }` + group membership + folder inheritance —
a recursive reachability question SQL can't express cleanly.
`GET .../check` returns the decision and its witness path.

### notes — graph per user

Markdown notes with `[[wiki-links]]`. `linksTo` edges parsed on write
(inverse: `linkedFrom` for backlinks via `inverseOf`). Fulltext search
over `searchable()` title/body via FTS5. `GET .../path?from=a&to=b`
uses shortest-path to show how two notes connect. Vector-indexed search
is unavailable on DO SQLite (no sqlite-vec); optional semantic search is
opt-in via Workers AI embeddings stored as `embedding(768)` props with
JS cosine ranking (the pattern from typegraph examples/11), documented
as brute-force with a pointer to pgvector/libSQL for indexed vectors.

## Conventions (from Corpus, the reference TypeGraph-on-DO app)

- pnpm; strict tsconfig (`exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, …); separate
  `tsconfig.eslint.json` for typed linting of test/config files.
- Flat ESLint: typescript-eslint strict+stylistic type-checked,
  `eslint-plugin-functional` (ReadonlyShallow type immutability),
  `eslint-plugin-import-x` (ordering, no-cycle, no-default-export except
  entries), `@vitest/eslint-plugin`, `eslint-config-prettier` last.
- Prettier defaults, `.editorconfig` 2-space.
- Single gate: `pnpm check` = typecheck && lint && format:check && test.
- `worker-configuration.d.ts` generated by `wrangler types`
  (postinstall), gitignored.
- Tests: `@cloudflare/vitest-pool-workers` against real DOs, fresh
  uniquely-named stub per test, no mocks.
- DO boot: `migrate` nothing (no ledger tables here) →
  `createSqliteBackend(drizzle(ctx.storage))` →
  `createStoreWithSchema(graph, backend, options)`. No example defines
  custom indexes; if one ever does, its boot must also call
  `store.materializeIndexes({ stopOnError: true, refreshStatistics: false })`
  (`refreshStatistics: false` required — DO SQLite rejects
  `PRAGMA analysis_limit` with `SQLITE_AUTH`).

## Decisions

- One generic `GraphDO` class, not one class per example — the demo _is_
  the claim that tenancy (and even example-selection) is just naming.
- Conventions (tsconfig/eslint/prettier/vitest/wrangler layout) copied
  from Corpus, the reference TypeGraph-on-DO app.
- No front-end build step: static `public/` assets, vanilla JS viz.
- Seeds are deterministic; no network calls in the default path.
