export type AiRunner = Readonly<{
  run: (
    model: string,
    inputs: Readonly<Record<string, unknown>>,
  ) => Promise<unknown>;
}>;

/**
 * Workers AI is opt-in: the binding stays commented out in wrangler.jsonc
 * because it always proxies to a real Cloudflare account and bills usage,
 * even under `wrangler dev`. Examples must degrade gracefully when absent.
 */
export function aiBinding(env: Env): AiRunner | undefined {
  return (env as Readonly<{ AI?: AiRunner }>).AI;
}
