// Implement tab: writes a prompt for Claude Code that reimplements what the
// paper built. Claude first lists the systems (models, architectures,
// algorithms…) the paper implements; when there is more than one, the reader
// picks which. The prompt may draw on web search and web fetch (official code,
// appendices). Results are cached per PDF, next to the Q&A cache.

import { h } from "./dom.js";

const state = {
  doc: null, // { hash, name, pageTexts } of the open PDF
  systems: null, // [{ name, kind, summary, pages }] once found
  chosen: null, // index into systems of the prompt shown or being written
  choosing: false, // the list of systems is shown to pick from
  result: null, // { prompt, webSources: [{ url, title }], model, webSearches, webFetches }
  busy: null, // "systems" | "prompt" while a request runs
  port: null,
};
const ui = {};

export function initImplement() {
  ui.notes = h("textarea", {
    class: "qa-input qa-impl-notes",
    rows: 2,
    placeholder: "Optional notes for the prompt, e.g. “PyTorch, one GPU, start with a small-scale run”.",
    onchange: save,
  });
  ui.web = h("input", { type: "checkbox", class: "qa-check", checked: true });
  ui.start = h("button", { class: "qa-btn qa-primary", type: "button", onclick: start }, "Write implementation prompt");
  ui.status = h("div", { class: "qa-status qa-impl-status" });
  ui.error = h("div", { class: "qa-error", hidden: true });
  ui.body = h("div", { class: "qa-list qa-impl-body" });
  ui.panel = h(
    "div",
    { class: "qa-panel qa-impl", role: "tabpanel" },
    ui.status,
    ui.error,
    h(
      "div",
      { class: "qa-compose" },
      h(
        "p",
        { class: "qa-impl-intro" },
        "Get a prompt for Claude Code that reimplements what this paper built: architecture, equations, hyperparameters and training, with page references and the gaps the paper leaves open.",
      ),
      ui.notes,
      h(
        "div",
        { class: "qa-options" },
        h(
          "label",
          {
            title:
              "Claude may search the web and read pages such as the official code and appendix ($10 per 1,000 searches on your API account; fetching pages costs only tokens)",
          },
          ui.web,
          "Search the web",
        ),
      ),
      h("div", { class: "qa-row" }, ui.start),
    ),
    ui.body,
  );
  setStatus("");
  render();
  return ui.panel;
}

/** Called whenever another PDF is opened (doc is null while it loads). */
export async function setImplementDocument(doc) {
  state.port?.disconnect();
  Object.assign(state, { doc, systems: null, chosen: null, choosing: false, result: null, busy: null, port: null });
  ui.notes.value = "";
  setStatus("");
  setError(null);
  if (doc) {
    const saved = (await chrome.storage.local.get(cacheKey()))[cacheKey()];
    if (saved && state.doc === doc) {
      Object.assign(state, { systems: saved.systems ?? null, chosen: saved.chosen ?? null, result: saved.result ?? null });
      ui.notes.value = saved.notes ?? "";
      state.choosing = !!state.systems && state.systems.length > 1 && !state.result;
    }
  }
  render();
}

// ---------------------------------------------------------------------------
// Cache

const cacheKey = () => `impl:${state.doc.hash}`;

function save() {
  if (!state.doc) return;
  chrome.storage.local.set({
    [cacheKey()]: {
      systems: state.systems,
      chosen: state.chosen,
      result: state.result,
      notes: ui.notes.value,
      updated: Date.now(),
    },
  });
}

// ---------------------------------------------------------------------------
// Requests

function start() {
  if (!state.doc || state.busy) return;
  if (!state.systems) findSystems();
  else if (state.chosen != null) writePrompt(state.chosen);
  else if (state.systems.length === 1) writePrompt(0);
  else showChoices(true);
}

// Sends one request to the service worker; onResult gets the reply.
function request(type, body, onResult) {
  const doc = state.doc;
  setError(null);
  state.busy = type === "systems" ? "systems" : "prompt";
  render();
  const port = chrome.runtime.connect({ name: "ask" });
  state.port = port;
  const done = () => {
    state.busy = null;
    state.port = null;
    try {
      port.disconnect();
    } catch {
      /* already closed */
    }
    render();
  };
  port.onMessage.addListener((msg) => {
    if (state.port !== port || state.doc !== doc) return;
    if (msg.type === "status") setStatus(msg.text);
    else if (msg.type === "progress") setStatus(`Receiving… ${msg.chars} characters`);
    else if (msg.type === "error") {
      setStatus("");
      setError(msg.error);
      done();
    } else if (msg.type === "result") {
      onResult(msg);
      save();
      done();
    }
  });
  port.onDisconnect.addListener(() => {
    if (state.port === port) {
      setError({ code: "disconnected", message: "Lost connection to the extension background. Please try again." });
      done();
    }
  });
  port.postMessage({ type, pageTexts: doc.pageTexts, ...body });
}

function findSystems() {
  request("systems", {}, (msg) => {
    state.systems = msg.systems;
    state.result = null;
    state.chosen = null;
    setStatus(
      msg.systems.length
        ? `Found ${msg.systems.length === 1 ? "one system" : `${msg.systems.length} systems`} · ${msg.model}`
        : `Read by ${msg.model}`,
    );
    // With a single system there is nothing to choose; write its prompt.
    if (msg.systems.length === 1) queueMicrotask(() => writePrompt(0));
    else state.choosing = msg.systems.length > 1;
  });
}

function showChoices(show) {
  state.choosing = show;
  render();
}

function writePrompt(index) {
  const system = state.systems[index];
  state.chosen = index;
  state.choosing = false;
  request(
    "implement",
    {
      system,
      others: state.systems.filter((_, i) => i !== index),
      notes: ui.notes.value,
      web: ui.web.checked,
    },
    (msg) => {
      state.result = {
        prompt: msg.prompt,
        webSources: msg.webSources,
        model: msg.model,
        webSearches: msg.webSearches,
        webFetches: msg.webFetches,
      };
      const cached = msg.usage?.cache_read_input_tokens ? ` (${Math.round(msg.usage.cache_read_input_tokens / 1000)}k cached)` : "";
      const web = [
        msg.webSearches ? `${msg.webSearches} web search${msg.webSearches === 1 ? "" : "es"}` : "",
        msg.webFetches ? `${msg.webFetches} page${msg.webFetches === 1 ? "" : "s"} fetched` : "",
      ].filter(Boolean);
      setStatus(`Written by ${msg.model}${cached}${web.length ? ` · ${web.join(" · ")}` : ""}`);
    },
  );
}

// ---------------------------------------------------------------------------
// Rendering

function setStatus(text) {
  ui.status.textContent = text;
}

function setError(err) {
  ui.error.hidden = !err;
  ui.error.replaceChildren();
  if (!err) return;
  ui.error.append(h("span", {}, err.message));
  if (["no_key", "auth", "model", "permission"].includes(err.code)) {
    ui.error.append(
      " ",
      h("button", { class: "qa-link", type: "button", onclick: () => chrome.runtime.openOptionsPage() }, "Open settings"),
    );
  }
}

function render() {
  ui.start.disabled = !state.doc || !!state.busy || state.systems?.length === 0;
  ui.start.textContent =
    state.busy === "systems"
      ? "Reading the paper…"
      : state.busy
        ? "Writing…"
        : state.result
          ? "Write again"
          : "Write implementation prompt";
  ui.body.replaceChildren(...bodyContent());
}

function bodyContent() {
  if (!state.doc) return [h("p", { class: "qa-empty" }, "Open a PDF to write an implementation prompt for it.")];
  const system = state.chosen != null ? state.systems?.[state.chosen] : null;
  if (state.busy === "systems") return [h("p", { class: "qa-empty" }, "Finding what the paper implements…")];
  if (state.busy === "prompt") {
    return [h("p", { class: "qa-empty" }, `Writing the prompt for ${system?.name ?? "the system"}… This can take a few minutes.`)];
  }
  if (state.systems && !state.systems.length) {
    return [h("p", { class: "qa-empty" }, "This paper doesn't seem to describe a model, system or method that can be implemented.")];
  }
  if (state.choosing) {
    return [
      h("p", { class: "qa-impl-hint" }, `This paper implements ${state.systems.length} things. Which one should the prompt build?`),
      ...state.systems.map((s, i) =>
        h(
          "button",
          { type: "button", class: "qa-impl-system", onclick: () => writePrompt(i) },
          h("span", { class: "qa-impl-system-name" }, s.name, s.kind ? h("span", { class: "qa-tag qa-tag-q" }, s.kind) : null),
          h("span", { class: "qa-impl-system-summary" }, s.summary),
          s.pages.length ? h("span", { class: "qa-page" }, `pp. ${s.pages.join(", ")}`) : null,
        ),
      ),
      state.result && system
        ? h("button", { class: "qa-link qa-impl-back", type: "button", onclick: () => showChoices(false) }, `Back to the prompt for ${system.name}`)
        : null,
    ];
  }
  if (!state.result) return [h("p", { class: "qa-empty" }, "Press the button to read the paper and write the prompt.")];

  const copy = h("button", { class: "qa-btn qa-primary", type: "button", onclick: (e) => copyPrompt(e.currentTarget) }, "Copy prompt");
  return [
    h(
      "div",
      { class: "qa-impl-head" },
      h("strong", {}, system ? `Prompt for ${system.name}` : "Implementation prompt"),
      state.systems?.length > 1
        ? h("button", { class: "qa-link", type: "button", onclick: () => showChoices(true) }, "Choose another system")
        : null,
    ),
    h(
      "div",
      { class: "qa-impl-actions" },
      copy,
      h("button", { class: "qa-btn", type: "button", onclick: downloadPrompt, title: "Save the prompt as a Markdown file" }, "Download .md"),
    ),
    h("pre", { class: "qa-impl-prompt", tabindex: 0 }, state.result.prompt),
    state.result.webSources?.length
      ? h(
          "div",
          { class: "qa-impl-sources" },
          h("div", { class: "qa-impl-hint" }, "Web pages used:"),
          h(
            "ol",
            {},
            state.result.webSources.map((src) =>
              h("li", {}, h("a", { href: src.url, target: "_blank", rel: "noreferrer", title: src.url }, src.title)),
            ),
          ),
        )
      : null,
  ];
}

async function copyPrompt(button) {
  try {
    await navigator.clipboard.writeText(state.result.prompt);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Copy failed";
  }
  setTimeout(() => (button.textContent = "Copy prompt"), 1500);
}

function downloadPrompt() {
  const blob = new Blob([state.result.prompt + "\n"], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: state.doc.name.replace(/\.pdf$/i, "") + "-implementation-prompt.md" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
