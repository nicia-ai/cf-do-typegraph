// Same-origin API helpers plus a tiny toast layer. Every fetch error is
// surfaced visibly — the demo never fails silently.

export const API_ROOT = "/api";

export function tenantBase(example, tenant) {
  return `${API_ROOT}/${encodeURIComponent(example)}/${encodeURIComponent(tenant)}`;
}

async function request(path, options = {}) {
  const response = await fetch(path, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const detail =
      body && typeof body === "object" && "error" in body
        ? body.error
        : `${response.status} ${response.statusText}`;
    throw new Error(detail);
  }
  return body;
}

export const api = {
  examples: () => request(`${API_ROOT}/examples`),
  spawn: (example, count, prefix) =>
    request(
      `${API_ROOT}/spawn/${encodeURIComponent(example)}?count=${count}&prefix=${encodeURIComponent(prefix)}`,
      { method: "POST" },
    ),
  seed: (example, tenant) =>
    request(`${tenantBase(example, tenant)}/seed`, { method: "POST" }),
  graph: (example, tenant, query = "") =>
    request(`${tenantBase(example, tenant)}/graph${query}`),
  get: (example, tenant, path) =>
    request(`${tenantBase(example, tenant)}${path}`),
  post: (example, tenant, path, body) =>
    request(`${tenantBase(example, tenant)}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
};

// Toasts ---------------------------------------------------------------

let toastHost = null;

function ensureHost() {
  if (toastHost) return toastHost;
  toastHost = document.createElement("div");
  toastHost.className = "toast-host";
  document.body.appendChild(toastHost);
  return toastHost;
}

export function toast(message, kind = "info") {
  const host = ensureHost();
  const el = document.createElement("div");
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("is-in"));
  setTimeout(() => {
    el.classList.remove("is-in");
    setTimeout(() => el.remove(), 260);
  }, 4200);
}

// Escape untrusted text before putting it in innerHTML. Search snippets
// arrive with server-sanitized <mark>…</mark>; everything else is escaped.
export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Render a search snippet: escape everything, then re-allow the <mark> tags
// the server emitted around matched terms.
export function renderSnippet(snippet) {
  return escapeHtml(snippet)
    .replaceAll("&lt;mark&gt;", "<mark>")
    .replaceAll("&lt;/mark&gt;", "</mark>");
}
