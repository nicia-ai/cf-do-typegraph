/**
 * The worker↔DO wire contract, defined once. The worker stamps these headers
 * on every forwarded request; the DO reads them to learn its identity.
 */
export const GRAPH_EXAMPLE_HEADER = "x-graph-example";
export const GRAPH_TENANT_HEADER = "x-graph-tenant";

/**
 * The whole provisioning scheme: a tenant's graph database is the Durable
 * Object instance with this name, and nothing else ever routes to it.
 */
export function doName(example: string, tenant: string): string {
  return `${example}:${tenant}`;
}
