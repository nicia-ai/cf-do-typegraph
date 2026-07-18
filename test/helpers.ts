import { SELF } from "cloudflare:test";
import { expect } from "vitest";

import type { GraphSnapshot } from "@/examples/types";

/**
 * Builds a tenant-scoped example URL. `path` includes its own leading slash
 * and any query string, e.g. `apiUrl("notes", "me", "/search?q=graph")`.
 */
export function apiUrl(example: string, tenant: string, path = ""): string {
  return `http://localhost/api/${example}/${tenant}${path}`;
}

/** GET a URL, assert it succeeded, and parse the JSON body as `T`. */
export async function getJson<T>(url: string): Promise<T> {
  const response = await SELF.fetch(url);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

/**
 * POST a URL, assert it succeeded, and parse the JSON body as `T`. A `body`,
 * when given, is JSON-encoded with a matching content-type; omit it for the
 * many mutation endpoints that take no request body.
 */
export async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await SELF.fetch(url, {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

/** POST `/seed` for a tenant and return its (example-specific) summary. */
export function seed<T = unknown>(example: string, tenant: string): Promise<T> {
  return postJson<T>(apiUrl(example, tenant, "/seed"));
}

/**
 * GET a tenant's `/graph` snapshot. `query` is an optional query string
 * (including the leading `?`), used for agent-memory's `?recorded=` replay.
 */
export function snapshot(
  example: string,
  tenant: string,
  query = "",
): Promise<GraphSnapshot> {
  return getJson<GraphSnapshot>(apiUrl(example, tenant, `/graph${query}`));
}
