// Landing page: fetch the example registry, render a card per example with a
// tenant picker and the "spawn N tenants" money shot, plus copyable curl.

import { api, escapeHtml, toast } from "./api.js";
import { configFor } from "./examples-config.js";

const SPAWN_COUNT = 25;

const examplesHost = document.getElementById("examples");
const curlHost = document.getElementById("curl");

function vizHref(example, tenant) {
  return `/viz?example=${encodeURIComponent(example)}&tenant=${encodeURIComponent(tenant)}`;
}

function cardTemplate({ name, description }) {
  const meta = configFor(name);
  const card = document.createElement("article");
  card.className = "card";
  card.dataset.example = name;
  card.innerHTML = `
    <span class="kind">${escapeHtml(meta.axis)}</span>
    <h3>${escapeHtml(name)}</h3>
    <p>${escapeHtml(description)}</p>
    <div class="tenant-row">
      <input class="tenant" value="${escapeHtml(meta.defaultTenant)}"
             spellcheck="false" aria-label="tenant for ${escapeHtml(name)}" />
      <a class="btn btn--accent open" href="${vizHref(name, meta.defaultTenant)}">Open graph →</a>
    </div>
    <div class="card-actions">
      <button class="btn btn--ghost spawn">Spawn ${SPAWN_COUNT} tenants</button>
    </div>
    <div class="spawn-out">
      <div class="spawn-caption"></div>
      <div class="tenant-grid"></div>
    </div>`;

  const input = card.querySelector(".tenant");
  const open = card.querySelector(".open");
  input.addEventListener("input", () => {
    open.href = vizHref(name, input.value.trim() || meta.defaultTenant);
  });

  const spawnBtn = card.querySelector(".spawn");
  spawnBtn.addEventListener("click", () =>
    spawn(name, meta, spawnBtn, card.querySelector(".spawn-out")),
  );

  return card;
}

async function spawn(example, meta, button, out) {
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Spawning…";
  try {
    // A fresh prefix per click so every batch mints genuinely new Durable
    // Objects — a fixed prefix would idempotently re-seed the same tenants.
    // A short per-card batch counter keeps names readable (user1-3, user2-3…)
    // and within the worker's [A-Za-z0-9._-] tenant charset.
    const batch = Number(out.dataset.batch || "0") + 1;
    out.dataset.batch = String(batch);
    const prefix = `${meta.spawnPrefix}${batch}`;
    const result = await api.spawn(example, SPAWN_COUNT, prefix);
    const tenants = result.seeded ?? [];
    const grid = out.querySelector(".tenant-grid");
    tenants.forEach((tenant, i) => {
      const link = document.createElement("a");
      link.href = vizHref(example, tenant);
      link.textContent = tenant;
      link.title = `${example}:${tenant}`;
      link.style.animationDelay = `${Math.min(i * 18, 600)}ms`;
      grid.appendChild(link);
    });
    // Grid grows across clicks; caption reflects the running total.
    const total = grid.querySelectorAll("a").length;
    out.querySelector(".spawn-caption").innerHTML =
      `<b>${total}</b> isolated graph databases, live. Each is its own Durable Object — open any.`;
    out.classList.add("is-open");
    button.textContent = `Spawn ${SPAWN_COUNT} more`;
  } catch (err) {
    toast(`Spawn failed: ${err.message}`, "error");
    button.textContent = originalLabel;
  } finally {
    button.disabled = false;
  }
}

function curlCard(title, lines) {
  const el = document.createElement("div");
  el.className = "snippet";
  const raw = lines.map((l) => l.text).join("\n");
  const html = lines
    .map((l) =>
      l.comment
        ? `<span class="c">${escapeHtml(l.text)}</span>`
        : escapeHtml(l.text).replace(
            /(https?:\/\/\S+)/,
            '<span class="u">$1</span>',
          ),
    )
    .join("\n");
  el.innerHTML = `
    <header><span>${escapeHtml(title)}</span><button class="copy">copy</button></header>
    <pre>${html}</pre>`;
  const btn = el.querySelector(".copy");
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(raw);
      btn.textContent = "copied";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = "copy";
        btn.classList.remove("copied");
      }, 1400);
    } catch {
      toast("Clipboard blocked by the browser", "error");
    }
  });
  return el;
}

function renderCurl(origin) {
  const c = (text) => ({ text, comment: true });
  const cmds = [
    [
      "Seed a tenant, read its graph",
      [
        c("# every name is its own SQLite-backed graph DB"),
        { text: `curl -X POST ${origin}/api/notes/ada/seed` },
        { text: `curl ${origin}/api/notes/ada/graph` },
      ],
    ],
    [
      "Spawn 25 workspaces at once",
      [
        c("# 25 Durable Objects, one request"),
        { text: `curl -X POST "${origin}/api/spawn/authz?count=25&prefix=ws"` },
      ],
    ],
    [
      "Ask an authz question via reachability",
      [
        c("# ALLOWED/DENIED + the witness path"),
        {
          text: `curl "${origin}/api/authz/acme/check?user=alice&relation=viewer&doc=roadmap"`,
        },
      ],
    ],
    [
      "Full-text search a user's notes (FTS5)",
      [
        c("# ranked hits with <mark> snippets"),
        { text: `curl "${origin}/api/notes/ada/search?q=durable+objects"` },
      ],
    ],
  ];
  cmds.forEach(([title, lines]) =>
    curlHost.appendChild(curlCard(title, lines)),
  );
}

async function main() {
  wireResolver();
  renderCurl(location.origin);
  try {
    const { examples } = await api.examples();
    examples.forEach((ex) => examplesHost.appendChild(cardTemplate(ex)));
  } catch (err) {
    toast(`Could not load examples: ${err.message}`, "error");
    examplesHost.innerHTML = `<p class="mono" style="color:var(--ink-faint)">API unreachable — is the worker running?</p>`;
  }
}

// The hero resolver echoes whatever you type into the "graph online" status,
// making the pitch literal: a name resolves to a live graph.
function wireResolver() {
  const input = document.getElementById("resolver-name");
  const result = document.getElementById("resolver-result");
  if (!input || !result) return;
  const sync = () => {
    const name = input.value.trim();
    // ch sizes the glyphs; the +18px covers the input's horizontal padding
    // (border-box) so names like "acme" aren't clipped.
    input.style.width = `calc(${Math.max(3, name.length)}ch + 18px)`;
    result.textContent = name ? "graph online" : "name required";
  };
  input.addEventListener("input", sync);
  sync();
}

main();
