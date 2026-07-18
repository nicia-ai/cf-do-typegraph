// Single source of truth for everything that varies per example: the landing
// card's display meta and the graph's color theme. A new example is one entry
// here, not three coordinated edits across index.js, graph.js, and viz.js.
//
// The `description` still comes from the API (/api/examples); this table holds
// only what the front-end decides — tenancy axis label, a fun default tenant,
// the spawn prefix, and the accent + node palette.

export const DEFAULT_EXAMPLE = "agent-memory";

export const EXAMPLES_CONFIG = {
  "agent-memory": {
    axis: "graph per conversation",
    defaultTenant: "session-42",
    spawnPrefix: "chat",
    accent: "#8b7cff",
    palette: ["#8b7cff", "#6366f1", "#b57cff", "#5b8cff", "#49b8c9", "#e07bd0"],
  },
  authz: {
    axis: "graph per workspace",
    defaultTenant: "acme",
    spawnPrefix: "ws",
    accent: "#f5b544",
    palette: ["#f5b544", "#fb8c4b", "#e8c65a", "#d9a066", "#f2795b", "#c0b24a"],
  },
  notes: {
    axis: "graph per user",
    defaultTenant: "ada",
    spawnPrefix: "user",
    accent: "#3fd68c",
    palette: ["#3fd68c", "#34d399", "#86d94a", "#2fd3b8", "#6ee7a8", "#40c4a8"],
  },
};

// A future example the front-end hasn't been taught about gets a neutral
// steel identity — never another example's axis label, tenant, or accent.
const NEUTRAL_CONFIG = {
  axis: "graph per tenant",
  defaultTenant: "demo",
  spawnPrefix: "demo",
  accent: "#8891a7",
  palette: ["#8891a7", "#6f7a92", "#a3adc2", "#5b8fb3", "#9d8fb0", "#7fa89e"],
};

export function configFor(example) {
  return EXAMPLES_CONFIG[example] ?? NEUTRAL_CONFIG;
}
