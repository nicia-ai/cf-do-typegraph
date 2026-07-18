/**
 * The bundled conversation replayed message-by-message. Extraction is
 * hand-authored here — the default, free, deterministic path. Each step
 * names the entities it introduces (for `mentions` edges) and the typed
 * relations it asserts between them.
 *
 * Step 8 is the showcase: the conversation introduces an Organization, a
 * kind the compile-time schema does not have. That step carries an
 * `evolution` the replay applies with `store.evolve(...)` — the graph grows
 * a new node and edge kind while the Durable Object is live.
 */

export type EntityKind = "Person" | "Topic" | "Place";
export type RelationKind = "worksWith" | "discusses" | "locatedIn";
export type Role = "user" | "assistant";

export type Mention = Readonly<{ kind: EntityKind; id: string; name: string }>;
export type Relation = Readonly<{
  kind: RelationKind;
  from: string;
  to: string;
}>;

export type OrgFact = Readonly<{ id: string; name: string }>;
export type Employment = Readonly<{ person: string; org: string }>;

/** The runtime schema change a single script step applies. */
export type Evolution = Readonly<{
  extension: unknown;
  organizations: readonly OrgFact[];
  employments: readonly Employment[];
}>;

export type ScriptStep = Readonly<{
  role: Role;
  text: string;
  mentions: readonly Mention[];
  relations: readonly Relation[];
  evolution?: Evolution;
}>;

function person(slug: string, name: string): Mention {
  return { kind: "Person", id: `person:${slug}`, name };
}
function topic(slug: string, name: string): Mention {
  return { kind: "Topic", id: `topic:${slug}`, name };
}
function place(slug: string, name: string): Mention {
  return { kind: "Place", id: `place:${slug}`, name };
}
function worksWith(from: Mention, to: Mention): Relation {
  return { kind: "worksWith", from: from.id, to: to.id };
}
function discusses(from: Mention, to: Mention): Relation {
  return { kind: "discusses", from: from.id, to: to.id };
}
function locatedIn(from: Mention, to: Mention): Relation {
  return { kind: "locatedIn", from: from.id, to: to.id };
}

const ada = person("ada", "Ada");
const grace = person("grace", "Grace");
const linus = person("linus", "Linus");

const launch = topic("launch", "Halo launch");
const latency = topic("latency", "latency");
const onboarding = topic("onboarding", "onboarding");
const pricing = topic("pricing", "pricing");

const berlin = place("berlin", "Berlin");

const northwind: OrgFact = { id: "org:northwind", name: "Northwind" };

/**
 * The graph extension applied at step 8. Untrusted-shaped JSON on purpose:
 * `validateGraphExtension(_, { strict: true })` is the gate every runtime
 * proposal — hand-authored or LLM-authored — passes through before `evolve`.
 */
const ORGANIZATION_EXTENSION = {
  nodes: {
    Organization: {
      description: "A company the conversation introduced mid-session",
      properties: { name: { type: "string", minLength: 1 } },
    },
  },
  edges: {
    worksAt: {
      description: "Person -> Organization affiliation",
      from: ["Person"],
      to: ["Organization"],
    },
  },
} as const;

export const SCRIPT: readonly ScriptStep[] = [
  {
    role: "user",
    text: "I'm Ada, and I'm PMing the Halo launch.",
    mentions: [ada, launch],
    relations: [discusses(ada, launch)],
  },
  {
    role: "user",
    text: "Grace is my lead engineer — we've shipped three products together.",
    mentions: [ada, grace],
    relations: [worksWith(ada, grace)],
  },
  {
    role: "assistant",
    text: "Noted. Do you want Grace to own the latency work?",
    mentions: [grace, latency],
    relations: [discusses(grace, latency)],
  },
  {
    role: "user",
    text: "Yes. And Linus is designing the onboarding flow.",
    mentions: [linus, onboarding],
    relations: [discusses(linus, onboarding)],
  },
  {
    role: "user",
    text: "The three of us are all in Berlin this quarter.",
    mentions: [ada, grace, linus, berlin],
    relations: [
      locatedIn(ada, berlin),
      locatedIn(grace, berlin),
      locatedIn(linus, berlin),
    ],
  },
  {
    role: "assistant",
    text: "Who owns pricing?",
    mentions: [pricing],
    relations: [],
  },
  {
    role: "user",
    text: "Ada does — I'll draft the tiers this week.",
    mentions: [ada, pricing],
    relations: [discusses(ada, pricing)],
  },
  {
    role: "user",
    text: "New development: we're partnering with Northwind, and Grace is their main contact.",
    mentions: [grace],
    relations: [],
    evolution: {
      extension: ORGANIZATION_EXTENSION,
      organizations: [northwind],
      employments: [{ person: grace.id, org: northwind.id }],
    },
  },
  {
    role: "assistant",
    text: "Understood — Grace now bridges Halo and Northwind.",
    mentions: [grace, launch],
    relations: [discusses(grace, launch)],
  },
  {
    role: "user",
    text: "Linus and Grace are pairing on the latency dashboard.",
    mentions: [linus, grace, latency],
    relations: [worksWith(linus, grace), discusses(linus, latency)],
  },
  {
    role: "assistant",
    text: "Is the launch date locked?",
    mentions: [launch],
    relations: [],
  },
  {
    role: "user",
    text: "Locked. Ada presents it in Berlin next month.",
    mentions: [ada, launch, berlin],
    relations: [],
  },
];
