import { agentMemoryExample } from "@/examples/agent-memory";
import { authzExample } from "@/examples/authz";
import { notesExample } from "@/examples/notes";
import type { ExampleModule } from "@/examples/types";

export const EXAMPLES = {
  "agent-memory": agentMemoryExample,
  authz: authzExample,
  notes: notesExample,
} as const satisfies Record<string, ExampleModule>;

export type ExampleName = keyof typeof EXAMPLES;

export const EXAMPLE_NAMES = Object.keys(EXAMPLES) as readonly ExampleName[];

export function isExampleName(value: string): value is ExampleName {
  // Object.hasOwn, not `in`: the guard must reject prototype-chain keys
  // like "toString" arriving from the URL.
  return Object.hasOwn(EXAMPLES, value);
}
