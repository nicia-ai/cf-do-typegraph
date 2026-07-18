// A small Fruchterman-Reingold-ish force-directed layout rendered to a
// Canvas. Deliberately dependency-free: all pairs repel, edges pull, a weak
// gravity keeps the graph centered, and the whole thing cools over time.
// Sizes here are demo-scale (tens to low hundreds of nodes), so the O(n^2)
// repulsion pass is fine and keeps the code readable.

const REPULSION = 5200; // Coulomb-ish node/node push
const SPRING_LENGTH = 78; // rest length of an edge
const SPRING_STIFFNESS = 0.035; // how hard edges pull toward rest length
const GRAVITY = 0.015; // pull toward center so nothing drifts away
const DAMPING = 0.86; // velocity retained each tick
const MAX_VELOCITY = 22; // clamp so nodes never teleport
const REHEAT_ALPHA = 0.9; // energy injected when data changes
const ALPHA_DECAY = 0.02; // how fast the simulation settles
const ALPHA_MIN = 0.02; // below this, we stop integrating (still render)

const NODE_RADIUS = 7;
const POP_MS = 420; // new-node scale-in duration
const FADE_MS = 340; // removed-node fade-out duration
const LABEL_FONT =
  '11px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const now = () => performance.now();

// Stable string hash → palette index, so a given kind always gets the same
// color across renders and reloads.
function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export class ForceGraph {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.palette = options.palette ?? ["#8b7cff"];
    this.accent = options.accent ?? "#8b7cff";
    this.onSelect = options.onSelect ?? (() => {});
    this.onHover = options.onHover ?? (() => {});

    this.nodes = new Map(); // id → { x, y, vx, vy, kind, label, pinned, born, dead }
    this.edges = []; // { id, kind, from, to }
    this.colorForKind = new Map();

    this.alpha = 0;
    this.running = false;
    this.selectedId = null;
    this.highlight = null; // Set<string> of node ids, or null for "show all"
    this.transform = { x: 0, y: 0, scale: 1 };

    this.pointer = { x: 0, y: 0, inside: false };
    this.drag = null; // { id, dx, dy } while dragging a node

    this.#resize();
    this.#bindEvents();
  }

  color(kind) {
    let color = this.colorForKind.get(kind);
    if (color === undefined) {
      color = this.palette[hashString(kind) % this.palette.length];
      this.colorForKind.set(kind, color);
    }
    return color;
  }

  // Merge a fresh snapshot: keep positions of surviving nodes, spawn new ones
  // near the center with a pop animation, and mark departed ones to fade.
  setData(snapshot) {
    const incoming = new Map(snapshot.nodes.map((node) => [node.id, node]));
    const t = now();
    const center = this.#center();

    for (const [id, node] of this.nodes) {
      if (!incoming.has(id) && !node.dead) node.dead = t;
    }

    for (const node of snapshot.nodes) {
      const existing = this.nodes.get(node.id);
      if (existing) {
        existing.kind = node.kind;
        existing.label = node.label;
        existing.dead = undefined;
      } else {
        this.nodes.set(node.id, {
          x: center.x + (Math.random() - 0.5) * 120,
          y: center.y + (Math.random() - 0.5) * 120,
          vx: 0,
          vy: 0,
          kind: node.kind,
          label: node.label,
          pinned: false,
          born: t,
          dead: undefined,
        });
      }
    }

    this.edges = snapshot.edges.filter(
      (edge) => incoming.has(edge.from) && incoming.has(edge.to),
    );

    this.reheat();
  }

  reheat() {
    this.alpha = REHEAT_ALPHA;
    this.start();
  }

  setHighlight(nodeIds) {
    this.highlight = nodeIds ? new Set(nodeIds) : null;
  }

  select(id) {
    this.selectedId = id;
    this.onSelect(id ? this.#publicNode(id) : null);
  }

  centerOn(id) {
    const node = this.nodes.get(id);
    if (!node) return;
    this.transform.x = this.rect.width / 2 - node.x * this.transform.scale;
    this.transform.y = this.rect.height / 2 - node.y * this.transform.scale;
  }

  counts() {
    const live = [...this.nodes.values()].filter((n) => !n.dead).length;
    return { nodes: live, edges: this.edges.length };
  }

  start() {
    if (this.running) return;
    this.running = true;
    const frame = () => {
      if (!this.running) return;
      this.#tick();
      this.#render();
      if (this.alpha <= ALPHA_MIN && !this.drag && !this.#animating()) {
        this.running = false; // settle: stop integrating, keep the last frame
        return;
      }
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  #animating() {
    const t = now();
    for (const node of this.nodes.values()) {
      if (t - node.born < POP_MS) return true;
      if (node.dead && t - node.dead < FADE_MS) return true;
    }
    return false;
  }

  #tick() {
    if (this.alpha > ALPHA_MIN) {
      const list = [...this.nodes.values()];

      for (let i = 0; i < list.length; i += 1) {
        const a = list[i];
        if (a.dead) continue;
        for (let j = i + 1; j < list.length; j += 1) {
          const b = list[j];
          if (b.dead) continue;
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let distSq = dx * dx + dy * dy;
          if (distSq < 0.01) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            distSq = 0.01;
          }
          const force = (REPULSION / distSq) * this.alpha;
          const dist = Math.sqrt(distSq);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
      }

      for (const edge of this.edges) {
        const a = this.nodes.get(edge.from);
        const b = this.nodes.get(edge.to);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const force = (dist - SPRING_LENGTH) * SPRING_STIFFNESS * this.alpha;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }

      const center = this.#center();
      for (const node of list) {
        if (node.dead || node.pinned) continue;
        node.vx += (center.x - node.x) * GRAVITY * this.alpha;
        node.vy += (center.y - node.y) * GRAVITY * this.alpha;
        node.vx = clamp(node.vx * DAMPING, -MAX_VELOCITY, MAX_VELOCITY);
        node.vy = clamp(node.vy * DAMPING, -MAX_VELOCITY, MAX_VELOCITY);
        node.x += node.vx;
        node.y += node.vy;
      }

      this.alpha = Math.max(0, this.alpha - ALPHA_DECAY);
    }

    // Reap fully-faded nodes.
    const t = now();
    for (const [id, node] of this.nodes) {
      if (node.dead && t - node.dead >= FADE_MS) this.nodes.delete(id);
    }
  }

  #render() {
    const ctx = this.ctx;
    const rect = this.rect;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.save();
    ctx.translate(this.transform.x, this.transform.y);
    ctx.scale(this.transform.scale, this.transform.scale);

    const t = now();
    const hasHighlight = this.highlight !== null;
    const isLit = (id) => !hasHighlight || this.highlight.has(id);

    for (const edge of this.edges) {
      const a = this.nodes.get(edge.from);
      const b = this.nodes.get(edge.to);
      if (!a || !b) continue;
      const lit = isLit(edge.from) && isLit(edge.to);
      ctx.globalAlpha =
        this.#opacity(a, t) * this.#opacity(b, t) * (lit ? 0.6 : 0.08);
      ctx.strokeStyle = lit && hasHighlight ? this.accent : "#3a4457";
      ctx.lineWidth = lit && hasHighlight ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    ctx.font = LABEL_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const [id, node] of this.nodes) {
      const scale = this.#scaleOf(node, t);
      const opacity = this.#opacity(node, t);
      const lit = isLit(id);
      const radius = NODE_RADIUS * scale;
      ctx.globalAlpha = opacity * (lit ? 1 : 0.18);

      if (id === this.selectedId) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius + 5, 0, Math.PI * 2);
        ctx.strokeStyle = this.accent;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = this.color(node.kind);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(8,11,17,0.9)";
      ctx.stroke();

      if (scale > 0.6) {
        ctx.globalAlpha = opacity * (lit ? 0.92 : 0.16);
        ctx.fillStyle = "#c9d2e2";
        ctx.fillText(node.label ?? "", node.x, node.y + radius + 4);
      }
    }

    ctx.restore();
    ctx.globalAlpha = 1;
  }

  #scaleOf(node, t) {
    if (t - node.born < POP_MS) {
      const p = (t - node.born) / POP_MS;
      return 1 - Math.pow(1 - p, 3); // ease-out cubic pop-in
    }
    if (node.dead) {
      const p = clamp((t - node.dead) / FADE_MS, 0, 1);
      return 1 - p * 0.4;
    }
    return 1;
  }

  #opacity(node, t) {
    if (node.dead) return 1 - clamp((t - node.dead) / FADE_MS, 0, 1);
    if (t - node.born < POP_MS) return (t - node.born) / POP_MS;
    return 1;
  }

  #center() {
    const rect = this.rect;
    return {
      x: (rect.width / 2 - this.transform.x) / this.transform.scale,
      y: (rect.height / 2 - this.transform.y) / this.transform.scale,
    };
  }

  #toWorld(clientX, clientY) {
    const rect = this.rect;
    return {
      x: (clientX - rect.left - this.transform.x) / this.transform.scale,
      y: (clientY - rect.top - this.transform.y) / this.transform.scale,
    };
  }

  #nodeAt(worldX, worldY) {
    let hit = null;
    for (const [id, node] of this.nodes) {
      if (node.dead) continue;
      const dx = worldX - node.x;
      const dy = worldY - node.y;
      if (dx * dx + dy * dy <= (NODE_RADIUS + 5) * (NODE_RADIUS + 5)) {
        hit = { id, node };
      }
    }
    return hit;
  }

  #publicNode(id) {
    const node = this.nodes.get(id);
    return node ? { id, kind: node.kind, label: node.label } : null;
  }

  #bindEvents() {
    const canvas = this.canvas;

    canvas.addEventListener("pointerdown", (event) => {
      this.rect = canvas.getBoundingClientRect(); // gesture may follow a scroll
      const world = this.#toWorld(event.clientX, event.clientY);
      const hit = this.#nodeAt(world.x, world.y);
      if (hit) {
        canvas.setPointerCapture(event.pointerId);
        this.drag = {
          id: hit.id,
          dx: hit.node.x - world.x,
          dy: hit.node.y - world.y,
        };
        hit.node.pinned = true;
        this.select(hit.id);
        this.start();
      } else {
        this.pan = { x: event.clientX, y: event.clientY };
        this.select(null);
      }
    });

    canvas.addEventListener("pointermove", (event) => {
      const world = this.#toWorld(event.clientX, event.clientY);
      if (this.drag) {
        const node = this.nodes.get(this.drag.id);
        if (node) {
          node.x = world.x + this.drag.dx;
          node.y = world.y + this.drag.dy;
          node.vx = 0;
          node.vy = 0;
        }
        return;
      }
      if (this.pan) {
        this.transform.x += event.clientX - this.pan.x;
        this.transform.y += event.clientY - this.pan.y;
        this.pan = { x: event.clientX, y: event.clientY };
        this.start();
        return;
      }
      const hit = this.#nodeAt(world.x, world.y);
      canvas.style.cursor = hit ? "pointer" : "grab";
      this.onHover(
        hit ? this.#publicNode(hit.id) : null,
        event.clientX,
        event.clientY,
      );
    });

    const endDrag = (event) => {
      if (this.drag) {
        try {
          canvas.releasePointerCapture(event.pointerId);
        } catch {
          // Capture may already be gone; nothing to release.
        }
      }
      this.drag = null;
      this.pan = null;
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("pointerleave", () => this.onHover(null, 0, 0));

    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const world = this.#toWorld(event.clientX, event.clientY);
        const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
        this.transform.scale = clamp(this.transform.scale * factor, 0.3, 3);
        this.transform.x =
          event.clientX - this.rect.left - world.x * this.transform.scale;
        this.transform.y =
          event.clientY - this.rect.top - world.y * this.transform.scale;
        this.start();
      },
      { passive: false },
    );

    window.addEventListener("resize", () => {
      this.#resize();
      this.start();
    });
  }

  // Cache the canvas rect: getBoundingClientRect forces a layout flush, so
  // calling it every frame from #render/#center thrashes on large graphs.
  // Refreshed here (window resize) and at the start of each pointer gesture.
  #resize() {
    this.rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(this.rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(this.rect.height * this.dpr));
  }
}

// The node palette + accent live in the shared per-example config; the
// ForceGraph engine reads them via its constructor options. Re-exported here
// so callers can grab a theme alongside the renderer.
export { configFor as themeFor } from "./examples-config.js";
