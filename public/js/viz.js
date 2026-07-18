// Shared graph view. Reads ?example=&tenant=, renders the live force graph,
// keeps a WebSocket open for mutation pushes, and mounts a per-example
// control strip (temporal replay, authz checks, notes search + path).

import { api, tenantBase, toast, escapeHtml, renderSnippet } from "./api.js";
import { ForceGraph, themeFor } from "./graph.js";
import { DEFAULT_EXAMPLE } from "./examples-config.js";

const PLAY_INTERVAL_MS = 1500;
const PING_INTERVAL_MS = 30000;
const RECONNECT_MS = 2000;

const params = new URLSearchParams(location.search);
const example = params.get("example") ?? DEFAULT_EXAMPLE;
const state = {
  tenant: params.get("tenant") ?? "demo",
  viewingHistory: false, // true while a temporal snapshot is pinned
  socket: null,
  pingTimer: null,
  playTimer: null,
};

const theme = themeFor(example);
document.body.dataset.example = example;

const el = {
  badge: document.getElementById("badge"),
  tenantInput: document.getElementById("tenant-input"),
  nodeCount: document.getElementById("node-count"),
  edgeCount: document.getElementById("edge-count"),
  connDot: document.getElementById("conn-dot"),
  connLabel: document.getElementById("conn-label"),
  controls: document.getElementById("controls"),
  legend: document.getElementById("legend"),
  verdict: document.getElementById("verdict"),
  results: document.getElementById("results"),
  empty: document.getElementById("empty"),
  seedBtn: document.getElementById("seed-btn"),
  tooltip: document.getElementById("tooltip"),
  canvas: document.getElementById("graph"),
};

el.badge.textContent = example;
el.tenantInput.value = state.tenant;
document.title = `${example}:${state.tenant} — TypeGraph`;

const graph = new ForceGraph(el.canvas, {
  palette: theme.palette,
  accent: theme.accent,
  onSelect: () => {},
  onHover: showTooltip,
});
graph.start();

// Tooltip ---------------------------------------------------------------

function showTooltip(node, clientX, clientY) {
  if (!node) {
    el.tooltip.classList.remove("is-on");
    return;
  }
  el.tooltip.querySelector(".k").textContent = node.kind;
  el.tooltip.querySelector(".l").textContent = node.label || node.id;
  el.tooltip.classList.add("is-on");
  el.tooltip.style.left = `${clientX + 14}px`;
  el.tooltip.style.top = `${clientY + 14}px`;
}

// Graph loading ---------------------------------------------------------

function updateCounts() {
  const { nodes, edges } = graph.counts();
  el.nodeCount.textContent = nodes;
  el.edgeCount.textContent = edges;
  el.empty.classList.toggle("is-on", nodes === 0 && !state.viewingHistory);
}

function renderLegend() {
  const kinds = new Set();
  for (const node of graph.nodes.values()) if (!node.dead) kinds.add(node.kind);
  const ul = el.legend.querySelector("ul");
  ul.innerHTML = "";
  [...kinds].sort().forEach((kind) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="swatch" style="background:${graph.color(kind)}"></span>${escapeHtml(kind)}`;
    ul.appendChild(li);
  });
  el.legend.hidden = kinds.size === 0;
}

async function loadGraph(query = "") {
  try {
    const snapshot = await api.graph(example, state.tenant, query);
    graph.setData(snapshot);
    updateCounts();
    renderLegend();
    return snapshot;
  } catch (err) {
    toast(`Failed to load graph: ${err.message}`, "error");
    return null;
  }
}

// WebSocket -------------------------------------------------------------

function setConnection(status) {
  const map = {
    live: ["dot--live", "live"],
    connecting: ["dot--off", "connecting…"],
    offline: ["dot--off", "offline"],
    paused: ["dot--off", "history"],
  };
  const [cls, label] = map[status];
  el.connDot.className = `dot ${cls}`;
  el.connLabel.textContent = label;
}

function connectWs() {
  if (state.socket) {
    state.socket.onclose = null;
    state.socket.close();
  }
  clearInterval(state.pingTimer);

  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const url = `${scheme}://${location.host}${tenantBase(example, state.tenant)}/ws`;
  setConnection("connecting");
  const socket = new WebSocket(url);
  state.socket = socket;

  socket.addEventListener("open", () => {
    setConnection(state.viewingHistory ? "paused" : "live");
    state.pingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send("ping");
    }, PING_INTERVAL_MS);
  });

  socket.addEventListener("message", (event) => {
    if (event.data === "pong") return;
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (payload.type === "graph-changed" && !state.viewingHistory) loadGraph();
  });

  socket.addEventListener("close", () => {
    clearInterval(state.pingTimer);
    setConnection("offline");
    setTimeout(connectWs, RECONNECT_MS);
  });

  socket.addEventListener("error", () => socket.close());
}

// Tenant switching ------------------------------------------------------

function switchTenant(next) {
  const tenant = next.trim();
  if (!tenant || tenant === state.tenant) return;
  // Tear down the old tenant's context: stop any agent-memory Play loop so it
  // doesn't keep POSTing /replay/step against the previous tenant.
  clearInterval(state.playTimer);
  state.playTimer = null;
  state.tenant = tenant;
  state.viewingHistory = false;
  clearHighlight();
  const url = new URL(location.href);
  url.searchParams.set("tenant", tenant);
  history.replaceState(null, "", url);
  document.title = `${example}:${tenant} — TypeGraph`;
  graph.nodes.clear();
  graph.edges = [];
  loadGraph();
  connectWs();
  buildControls();
}

el.tenantInput.addEventListener("change", () =>
  switchTenant(el.tenantInput.value),
);
el.tenantInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") el.tenantInput.blur();
});

el.seedBtn.addEventListener("click", async () => {
  el.seedBtn.disabled = true;
  try {
    await api.seed(example, state.tenant);
    toast("Seeded — watch the graph fill in", "success");
    await loadGraph();
  } catch (err) {
    toast(`Seed failed: ${err.message}`, "error");
  } finally {
    el.seedBtn.disabled = false;
  }
});

// Highlight helpers (authz check, notes path) ---------------------------

function applyHighlight(pathNodeIds) {
  graph.setHighlight(pathNodeIds && pathNodeIds.length ? pathNodeIds : null);
  graph.reheat();
}

function clearHighlight() {
  graph.setHighlight(null);
  el.verdict.classList.remove("is-on");
}

// Control strips --------------------------------------------------------

function control(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// Each example owns a self-contained control strip; dispatch by name.
// Unknown examples get no strip (same as before), matching the theme's own
// silent fallback.
const CONTROL_BUILDERS = {
  "agent-memory": buildMemoryControls,
  authz: buildAuthzControls,
  notes: buildNotesControls,
};

function buildControls() {
  el.controls.innerHTML = "";
  el.results.classList.remove("is-on");
  el.verdict.classList.remove("is-on");
  CONTROL_BUILDERS[example]?.();
}

// agent-memory: step through a scripted conversation, then scrub time.
function buildMemoryControls() {
  const strip = control(`
    <div style="display:contents">
      <div class="group">
        <button class="btn btn--accent" data-step>Step ▸</button>
        <button class="btn" data-play>Play</button>
        <span class="slider-cap" data-progress></span>
      </div>
      <div class="divider"></div>
      <div class="group" data-timeline hidden>
        <label>memory as of</label>
        <input type="range" min="0" max="0" value="0" data-slider />
        <span class="slider-cap" data-caption>live</span>
      </div>
    </div>`);
  el.controls.appendChild(strip);

  const stepBtn = strip.querySelector("[data-step]");
  const playBtn = strip.querySelector("[data-play]");
  const progress = strip.querySelector("[data-progress]");
  const timelineGroup = strip.querySelector("[data-timeline]");
  const slider = strip.querySelector("[data-slider]");
  const caption = strip.querySelector("[data-caption]");

  let steps = [];
  let done = false;

  async function refreshTimeline() {
    try {
      const data = await api.get(example, state.tenant, "/timeline");
      steps = data.steps ?? [];
    } catch {
      steps = [];
    }
    if (steps.length > 0) {
      timelineGroup.hidden = false;
      slider.max = String(steps.length);
      if (!state.viewingHistory) slider.value = slider.max;
    }
  }

  async function step() {
    stepBtn.disabled = true;
    try {
      const res = await api.post(example, state.tenant, "/replay/step", {});
      progress.textContent = `message ${res.index}/${res.total}`;
      done = res.done;
      await loadGraph();
      await refreshTimeline();
      slider.value = slider.max;
      if (done) {
        stepBtn.disabled = true;
        stepBtn.textContent = "replay complete";
        stopPlay();
      } else {
        stepBtn.disabled = false;
      }
    } catch (err) {
      toast(`Replay step failed: ${err.message}`, "error");
      stepBtn.disabled = false;
    }
  }

  function stopPlay() {
    clearInterval(state.playTimer);
    state.playTimer = null;
    playBtn.textContent = "Play";
  }

  playBtn.addEventListener("click", () => {
    if (state.playTimer) {
      stopPlay();
      return;
    }
    playBtn.textContent = "Pause";
    step();
    state.playTimer = setInterval(() => {
      if (done) stopPlay();
      else step();
    }, PLAY_INTERVAL_MS);
  });

  stepBtn.addEventListener("click", step);

  slider.addEventListener("input", async () => {
    const idx = Number(slider.value);
    if (idx >= steps.length) {
      // Back to the live head: resume WS-driven updates.
      state.viewingHistory = false;
      caption.textContent = "live";
      setConnection(
        state.socket?.readyState === WebSocket.OPEN ? "live" : "offline",
      );
      await loadGraph();
      renderLegend();
      return;
    }
    // A step may lack a recorded instant (the server skips the stamp when
    // recordedNow() is undefined). Snap back to the nearest earlier step that
    // has one; if none exists yet, stay live rather than querying ?recorded=null.
    let snap = idx;
    while (snap >= 0 && steps[snap]?.recordedAt == null) snap -= 1;
    if (snap < 0) return;
    const at = steps[snap];
    state.viewingHistory = true;
    setConnection("paused");
    caption.textContent = `msg ${at.index} · ${truncate(at.text, 42)}`;
    await loadGraph(`?recorded=${encodeURIComponent(at.recordedAt)}`);
    renderLegend();
  });

  refreshTimeline();
}

// authz: ask a reachability question, show verdict + witness path.
function buildAuthzControls() {
  const strip = control(`
    <div style="display:contents">
      <div class="group">
        <label>user</label>
        <input data-user value="alice" style="width:11ch" spellcheck="false" />
      </div>
      <div class="group">
        <label>relation</label>
        <select data-relation>
          <option value="viewer">viewer</option>
          <option value="editor">editor</option>
          <option value="owner">owner</option>
        </select>
      </div>
      <div class="group">
        <label>doc</label>
        <input data-doc value="roadmap" style="width:13ch" spellcheck="false" />
      </div>
      <button class="btn btn--accent" data-check>Check access</button>
    </div>`);
  el.controls.appendChild(strip);

  const run = async () => {
    const user = strip.querySelector("[data-user]").value.trim();
    const relation = strip.querySelector("[data-relation]").value;
    const doc = strip.querySelector("[data-doc]").value.trim();
    const q = `/check?user=${encodeURIComponent(user)}&relation=${encodeURIComponent(relation)}&doc=${encodeURIComponent(doc)}`;
    try {
      const res = await api.get(example, state.tenant, q);
      const allowed = Boolean(res.allowed);
      // Hops = edges traversed. Prefer the edge list; fall back to nodes − 1.
      const hops =
        res.pathEdgeKinds?.length ??
        Math.max(0, (res.pathNodeIds ?? []).length - 1);
      el.verdict.className = `panel verdict is-on ${allowed ? "allow" : "deny"}`;
      el.verdict.querySelector(".call").textContent = allowed
        ? "ALLOWED"
        : "DENIED";
      el.verdict.querySelector(".why").textContent = allowed
        ? `${user} → ${relation} → ${doc} · ${hops}-hop path`
        : `no ${relation} path from ${user} to ${doc}`;
      applyHighlight(allowed ? res.pathNodeIds : null);
    } catch (err) {
      toast(`Check failed: ${err.message}`, "error");
    }
  };

  strip.querySelector("[data-check]").addEventListener("click", run);
  strip.querySelectorAll("input").forEach((input) =>
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") run();
    }),
  );
}

// notes: full-text search + shortest path between two notes.
function buildNotesControls() {
  const strip = control(`
    <div style="display:contents">
      <div class="group">
        <label>search</label>
        <input data-q placeholder="durable objects" style="width:20ch" spellcheck="false" />
        <button class="btn btn--accent" data-search>Search</button>
      </div>
      <div class="divider"></div>
      <div class="group">
        <label>path</label>
        <input data-from placeholder="from" style="width:11ch" spellcheck="false" />
        <span style="color:var(--ink-ghost)">→</span>
        <input data-to placeholder="to" style="width:11ch" spellcheck="false" />
        <button class="btn" data-path>Trace</button>
      </div>
    </div>`);
  el.controls.appendChild(strip);

  const runSearch = async () => {
    const q = strip.querySelector("[data-q]").value.trim();
    if (!q) {
      el.results.classList.remove("is-on");
      return;
    }
    try {
      const res = await api.get(
        example,
        state.tenant,
        `/search?q=${encodeURIComponent(q)}`,
      );
      renderHits(res.hits ?? []);
    } catch (err) {
      toast(`Search failed: ${err.message}`, "error");
    }
  };

  const runPath = async () => {
    const from = strip.querySelector("[data-from]").value.trim();
    const to = strip.querySelector("[data-to]").value.trim();
    if (!from || !to) return;
    try {
      const res = await api.get(
        example,
        state.tenant,
        `/path?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
      if (res.found) {
        applyHighlight(res.pathNodeIds);
        toast(
          `Connected in ${res.depth} hop${res.depth === 1 ? "" : "s"}`,
          "success",
        );
      } else {
        clearHighlight();
        toast(`No path from ${from} to ${to}`, "info");
      }
    } catch (err) {
      toast(`Path failed: ${err.message}`, "error");
    }
  };

  strip.querySelector("[data-search]").addEventListener("click", runSearch);
  strip.querySelector("[data-q]").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });
  strip.querySelector("[data-path]").addEventListener("click", runPath);
  strip.querySelectorAll("[data-from],[data-to]").forEach((input) =>
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") runPath();
    }),
  );
}

function renderHits(hits) {
  const list = el.results.querySelector(".list");
  el.results.querySelector(".count").textContent =
    `${hits.length} hit${hits.length === 1 ? "" : "s"}`;
  list.innerHTML = "";
  if (hits.length === 0) {
    list.innerHTML = `<div class="hit"><div class="snip">No matches.</div></div>`;
  }
  hits.forEach((hit) => {
    const item = document.createElement("div");
    item.className = "hit";
    item.innerHTML = `
      <div class="title"><span>${escapeHtml(hit.title)}</span><span class="score">${(hit.score ?? 0).toFixed(2)}</span></div>
      <div class="snip">${renderSnippet(hit.snippet ?? "")}</div>`;
    item.addEventListener("click", () => {
      graph.select(hit.id);
      graph.centerOn(hit.id);
      graph.setHighlight([hit.id]);
      graph.reheat();
    });
    list.appendChild(item);
  });
  el.results.classList.add("is-on");
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Boot ------------------------------------------------------------------

buildControls();
loadGraph();
connectWs();
