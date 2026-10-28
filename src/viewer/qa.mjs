// Q&A sidebar for the pdf.js viewer: questions, Claude answers, highlights,
// per-PDF cache and annotated export.

import { buildIndex, matchQuote, pageText } from "../../lib/matcher.js";
import { getSettings, modelInfo } from "../../shared/models.js";
import { exportAnnotated } from "./export.js";
import { answersToMarkdown } from "./markdown.js";
import { h } from "./dom.js";
import { initPapers } from "./papers.mjs";

const app = window.PDFViewerApplication;

export const COLORS = ["#ffd400", "#4dabf7", "#69db7c", "#ff8787", "#b197fc", "#ffa94d", "#38d9a9", "#f783ac"];

const state = {
  doc: null, // { hash, name, bytes, pages, pageTexts, index }
  src: null, // the PDF's own URL, when it was opened from one
  questions: [], // [{ id, text, color, web, freeform }]
  results: {}, // id -> { answerable, answer, quotes: [{ text, page }], webSources: [{ url, title, quote }], model }
  matches: {}, // id -> [match per quote]
  pending: new Set(), // ids currently being asked
  status: "",
  error: null,
  port: null,
};

// ---------------------------------------------------------------------------
// Sidebar layout

const ui = {};

function buildSidebar() {
  ui.status = h("div", { class: "qa-status" });
  ui.error = h("div", { class: "qa-error", hidden: true });
  ui.input = h("textarea", {
    class: "qa-input",
    rows: 3,
    placeholder: "Ask about this paper…\nOne question per line.",
    onkeydown: (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        addQuestionsFromInput();
      }
    },
  });
  ui.web = h("input", { type: "checkbox", class: "qa-check" });
  ui.freeform = h("input", { type: "checkbox", class: "qa-check" });
  ui.add = h("button", { class: "qa-btn", type: "button", onclick: addQuestionsFromInput, title: "⌘/Ctrl+Enter" }, "Add");
  ui.ask = h("button", { class: "qa-btn qa-primary", type: "button", onclick: () => ask(false) }, "Find answers");
  ui.list = h("div", { class: "qa-list" });
  ui.export = h("button", { class: "qa-btn", type: "button", onclick: doExport }, "Export annotated PDF");
  ui.markdown = h(
    "button",
    { class: "qa-btn", type: "button", onclick: doExportMarkdown, title: "Questions, answers and quotes with page numbers" },
    "Export Markdown",
  );
  ui.reask = h("button", { class: "qa-btn", type: "button", onclick: () => ask(true) }, "Re-ask all");
  ui.clear = h("button", { class: "qa-btn qa-danger", type: "button", onclick: clearAll }, "Clear");

  ui.root = h(
    "aside",
    { id: "qaSidebar", class: "qa-sidebar" },
    h(
      "header",
      { class: "qa-header" },
      h("strong", {}, "Paper Q&A"),
      h(
        "div",
        { class: "qa-header-actions" },
        h("button", { class: "qa-icon", type: "button", title: "Settings", onclick: () => chrome.runtime.openOptionsPage() }, "⚙"),
        h("button", { class: "qa-icon", type: "button", title: "Hide sidebar", onclick: () => toggleSidebar(false) }, "»"),
      ),
    ),
    ui.status,
    ui.error,
    h(
      "div",
      { class: "qa-compose" },
      ui.input,
      h(
        "div",
        { class: "qa-options" },
        h(
          "label",
          { title: "Claude may also search the web for these questions ($10 per 1,000 searches on your API account)" },
          ui.web,
          "Search the web",
        ),
        h(
          "label",
          {
            title:
              "Answer in whatever format the request asks for (lists, tables, JSON…); quotes become optional. The whole box is one request.",
          },
          ui.freeform,
          "Free-form answer",
        ),
      ),
      h("div", { class: "qa-row" }, ui.add, ui.ask),
    ),
    ui.list,
    h("footer", { class: "qa-footer" }, ui.export, ui.markdown, ui.reask, ui.clear),
  );
  ui.reopen = h(
    "button",
    { class: "qa-reopen", type: "button", title: "Show Paper Q&A", hidden: true, onclick: () => toggleSidebar(true) },
    "Q&A",
  );
  document.body.append(ui.root, ui.reopen);
  document.documentElement.classList.add("qa-open");
}

function toggleSidebar(open) {
  document.documentElement.classList.toggle("qa-open", open);
  ui.root.hidden = !open;
  ui.reopen.hidden = open;
  try {
    localStorage.setItem("qa-sidebar", open ? "open" : "closed");
  } catch {
    /* storage unavailable */
  }
  // Let pdf.js recompute "page-width"/"auto" zoom for the new width.
  window.dispatchEvent(new Event("resize"));
}

function setStatus(text) {
  state.status = text;
  ui.status.textContent = text;
}

function setError(err) {
  state.error = err;
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

function badge(match) {
  if (!match) return null;
  switch (match.status) {
    case "exact":
      return null;
    case "approximate":
      return h("span", { class: "qa-badge", title: "Close but not exact match" }, `≈ ${Math.round(match.score * 100)}%`);
    case "low":
      return h(
        "span",
        { class: "qa-badge qa-low", title: "Low-confidence match: the highlighted text may not be what Claude quoted" },
        `⚠ low confidence ${Math.round(match.score * 100)}%`,
      );
    default:
      return h("span", { class: "qa-badge qa-none", title: "This quote could not be found in the PDF text" }, "not found in text");
  }
}

function render() {
  const hasDoc = !!state.doc;
  const unanswered = state.questions.filter((q) => !state.results[q.id] && !state.pending.has(q.id));
  ui.ask.disabled = !hasDoc || unanswered.length === 0 || state.pending.size > 0;
  ui.ask.textContent = state.pending.size ? "Asking…" : `Find answers${unanswered.length > 1 ? ` (${unanswered.length})` : ""}`;
  ui.reask.disabled = !hasDoc || state.questions.length === 0 || state.pending.size > 0;
  ui.export.disabled = !hasDoc || Object.keys(state.matches).length === 0;
  ui.markdown.disabled = !hasDoc || Object.keys(state.results).length === 0;
  ui.clear.disabled = state.questions.length === 0 || state.pending.size > 0;

  ui.list.replaceChildren(
    ...state.questions.map((q, n) => {
      const res = state.results[q.id];
      const matches = state.matches[q.id] ?? [];
      const body = [];
      if (state.pending.has(q.id)) {
        body.push(h("div", { class: "qa-answer qa-muted" }, "Waiting for Claude…"));
      } else if (!res) {
        body.push(h("div", { class: "qa-answer qa-muted" }, "Not asked yet."));
      } else {
        body.push(
          h(
            "div",
            { class: `qa-answer${res.answerable ? "" : " qa-unanswerable"}${q.freeform ? " qa-freeform" : ""}` },
            res.answerable ? null : h("span", { class: "qa-tag" }, "Not answered in the paper"),
            res.answer,
          ),
        );
        if (q.freeform && res.answerable) {
          body.push(
            h(
              "div",
              { class: "qa-answer-actions" },
              h("button", { class: "qa-link", type: "button", onclick: (e) => copyAnswer(e.currentTarget, res.answer) }, "Copy answer"),
            ),
          );
        }
        if (res.quotes.length) {
          body.push(
            h(
              "ol",
              { class: "qa-quotes" },
              res.quotes.map((quote, qi) => {
                const m = matches[qi];
                const found = m && m.segments.length > 0;
                const page = found ? m.page : quote.page;
                return h(
                  "li",
                  {},
                  h(
                    "button",
                    {
                      type: "button",
                      class: `qa-quote${found ? "" : " qa-missing"}`,
                      disabled: !found,
                      title: found ? "Show in PDF" : "Not found in the PDF text layer",
                      onclick: () => jumpTo(q.id, qi),
                    },
                    h("span", { class: "qa-page" }, page ? `p. ${page}` : "p. ?"),
                    h("span", { class: "qa-quote-text" }, `“${quote.text}”`),
                    badge(m),
                  ),
                );
              }),
            ),
          );
        }
        if (res.webSources?.length) {
          body.push(
            h(
              "ol",
              { class: "qa-quotes qa-web" },
              res.webSources.map((src) =>
                h(
                  "li",
                  {},
                  h(
                    "a",
                    { class: "qa-quote qa-web-source", href: src.url, target: "_blank", rel: "noreferrer", title: src.url },
                    h("span", { class: "qa-page" }, hostname(src.url)),
                    h("span", { class: "qa-web-title" }, src.title),
                    src.quote ? h("span", { class: "qa-quote-text" }, `“${src.quote}”`) : null,
                  ),
                ),
              ),
            ),
          );
        }
      }
      return h(
        "section",
        { class: "qa-card", style: { "--qa-color": q.color } },
        h(
          "div",
          { class: "qa-q" },
          h("span", { class: "qa-swatch" }),
          h(
            "span",
            { class: "qa-q-text" },
            `${n + 1}. ${q.text}`,
            q.web ? h("span", { class: "qa-tag qa-tag-q", title: "Claude may search the web for this question" }, "web") : null,
            q.freeform ? h("span", { class: "qa-tag qa-tag-q", title: "Free-form answer; quotes are optional" }, "free-form") : null,
          ),
          h(
            "button",
            {
              class: "qa-icon qa-remove",
              type: "button",
              title: "Remove question",
              disabled: state.pending.has(q.id),
              onclick: () => removeQuestion(q.id),
            },
            "✕",
          ),
        ),
        body,
      );
    }),
  );
  if (!state.questions.length) {
    ui.list.append(
      h("p", { class: "qa-empty" }, hasDoc ? "Add a question to get started." : "Open a PDF to ask questions about it."),
    );
  }
}

function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "web";
  }
}

async function copyAnswer(button, text) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Copy failed";
  }
  setTimeout(() => (button.textContent = "Copy answer"), 1500);
}

// ---------------------------------------------------------------------------
// Questions

let nextId = 1;
function newQuestion(text, { web = false, freeform = false } = {}) {
  const used = new Set(state.questions.map((q) => q.color));
  const color = COLORS.find((c) => !used.has(c)) ?? COLORS[state.questions.length % COLORS.length];
  return { id: `q${Date.now().toString(36)}${nextId++}`, text, color, web, freeform };
}

function addQuestionsFromInput() {
  const freeform = ui.freeform.checked;
  // A free-form request often spans lines (e.g. a format spec), so it stays whole.
  const lines = freeform
    ? [ui.input.value.trim()].filter(Boolean)
    : ui.input.value
        .split("\n")
        .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim())
        .filter(Boolean);
  if (!lines.length) return;
  for (const line of lines) state.questions.push(newQuestion(line, { web: ui.web.checked, freeform }));
  ui.input.value = "";
  save();
  render();
}

function removeQuestion(id) {
  state.questions = state.questions.filter((q) => q.id !== id);
  delete state.results[id];
  delete state.matches[id];
  save();
  refreshHighlights();
  render();
}

function clearAll() {
  if (!confirm("Remove all questions, answers and highlights for this PDF?")) return;
  state.questions = [];
  state.results = {};
  state.matches = {};
  save();
  refreshHighlights();
  render();
}

// ---------------------------------------------------------------------------
// Cache (chrome.storage.local, keyed by SHA-256 of the file)

const cacheKey = () => `doc:${state.doc.hash}`;

async function save() {
  if (!state.doc) return;
  await chrome.storage.local.set({
    [cacheKey()]: {
      name: state.doc.name,
      questions: state.questions,
      results: state.results,
      updated: Date.now(),
    },
  });
}

async function restore() {
  const saved = (await chrome.storage.local.get(cacheKey()))[cacheKey()];
  if (!saved) return false;
  state.questions = saved.questions ?? [];
  state.results = saved.results ?? {};
  return state.questions.length > 0;
}

// ---------------------------------------------------------------------------
// Document loading

async function loadFromParam() {
  const src = new URLSearchParams(location.search).get("src");
  if (!src) return;
  state.src = src;
  // Show the PDF's own URL in the address bar; the service worker routes it
  // back to the viewer on reload.
  if (/^(https?|file):/i.test(src)) history.replaceState(history.state, "", chrome.runtime.getURL("") + src + location.hash);
  setStatus("Loading PDF…");
  try {
    const bytes = await fetchBytes(src);
    const name = decodeURIComponent(new URL(src).pathname.split("/").pop() || "document.pdf");
    // pdf.js transfers (detaches) the buffer it is given, so hand it a copy.
    await app.open({ data: bytes.slice(), filename: /\.pdf$/i.test(name) ? name : `${name}.pdf` });
    app.setTitleUsingUrl?.(src, src);
  } catch (e) {
    const fileHint = src.startsWith("file:")
      ? ' For local files, enable "Allow access to file URLs" for Paper Q&A on chrome://extensions.'
      : "";
    setError({ code: "load", message: `Couldn't load the PDF: ${e.message}.${fileHint}` });
    setStatus("");
  }
}

async function fetchBytes(src) {
  if (src.startsWith("file:")) {
    // fetch() doesn't support file:// URLs; XHR does from extension pages
    // once "Allow access to file URLs" is on.
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", src);
      xhr.responseType = "arraybuffer";
      xhr.onload = () =>
        xhr.response && xhr.response.byteLength
          ? resolve(new Uint8Array(xhr.response))
          : reject(new Error("file is empty or not readable"));
      xhr.onerror = () => reject(new Error("access to the local file was denied"));
      xhr.send();
    });
  }
  const res = await fetch(src, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function onDocumentLoaded() {
  const pdf = app.pdfDocument;
  state.doc = null;
  state.questions = [];
  state.results = {};
  state.matches = {};
  painted.clear();
  setError(null);
  render();

  const bytes = await pdf.getData();
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    if (p % 10 === 1) setStatus(`Reading text… page ${p} of ${pdf.numPages}`);
    const page = await pdf.getPage(p);
    // Same parameters TextLayerBuilder uses, so item i is text-layer span i.
    const tc = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
    pages.push({
      items: tc.items
        .filter((it) => it.str !== undefined)
        .map(({ str, hasEOL, transform, width, height }) => ({ str, hasEOL, transform, width, height })),
    });
  }
  if (app.pdfDocument !== pdf) return; // another document was opened meanwhile

  const pageTexts = pages.map(pageText);
  const index = buildIndex(pages);
  state.doc = { hash, name: app._docFilename || "document.pdf", bytes, pages, pageTexts, index };

  const chars = pageTexts.reduce((a, t) => a + t.length, 0);
  if (index.key.length < 100 * pdf.numPages) {
    setError({
      code: "no_text",
      message:
        index.key.length === 0
          ? "This PDF has no text layer (it is probably a scanned image), so answers can't be found or highlighted. Run it through OCR first."
          : "This PDF has very little selectable text (it may be partly scanned). Answers and highlights may be incomplete.",
    });
  }

  const restored = await restore();
  const settings = await getSettings();
  const info = modelInfo(settings.model);
  const tokens = Math.ceil(chars / 3.5);
  const cost = info.input ? ` · ~$${((tokens / 1e6) * info.input).toFixed(2)} input per ask` : "";
  setStatus(
    `${pdf.numPages} pages · ~${Math.round(tokens / 1000)}k tokens${cost}` + (restored ? " · restored from cache" : ""),
  );
  if (tokens > info.context * 0.9) {
    setError({
      code: "too_long",
      message: `This PDF has ~${Math.round(tokens / 1000)}k tokens of text, more than ${settings.model} can read at once.`,
    });
  }
  if (!settings.apiKey) {
    setError({ code: "no_key", message: "Add your Anthropic API key to start asking questions." });
  }
  rematchAll();
  render();
  // Pages rendered while the text was being read missed their
  // "textlayerrendered" event; paint them now.
  for (let i = 0; i < pdf.numPages; i++) {
    const pv = app.pdfViewer.getPageView(i);
    if (pv?.textLayer?.div.querySelector(".endOfContent")) onTextLayerRendered({ source: pv, pageNumber: i + 1 });
  }
}

// ---------------------------------------------------------------------------
// Asking Claude

function ask(all) {
  if (!state.doc || state.pending.size) return;
  const targets = state.questions.filter((q) => all || !state.results[q.id]);
  if (!targets.length) return;
  setError(null);
  for (const q of targets) state.pending.add(q.id);
  render();

  const port = chrome.runtime.connect({ name: "ask" });
  state.port = port;
  const statusBefore = state.status;
  const done = () => {
    for (const q of targets) state.pending.delete(q.id);
    state.port = null;
    try {
      port.disconnect();
    } catch {
      /* already closed */
    }
    render();
  };
  port.onMessage.addListener((msg) => {
    if (msg.type === "status") setStatus(msg.text);
    else if (msg.type === "progress") setStatus(`Receiving answers… ${msg.chars} characters`);
    else if (msg.type === "error") {
      setStatus(statusBefore);
      setError(msg.error);
      done();
    } else if (msg.type === "result") {
      targets.forEach((q, i) => {
        state.results[q.id] = { ...msg.answers[i], model: msg.model };
        state.matches[q.id] = matchAnswer(state.results[q.id]);
      });
      const u = msg.usage ?? {};
      const cached = u.cache_read_input_tokens ? ` (${Math.round(u.cache_read_input_tokens / 1000)}k cached)` : "";
      const searches = msg.webSearches ? ` · ${msg.webSearches} web search${msg.webSearches === 1 ? "" : "es"}` : "";
      setStatus(`Answered by ${msg.model}${cached}${searches}`);
      save();
      refreshHighlights();
      done();
      // Bring the first new highlight into view.
      const first = targets.find((q) => state.matches[q.id]?.some((m) => m.segments.length));
      if (first) jumpTo(first.id, state.matches[first.id].findIndex((m) => m.segments.length));
    }
  });
  port.onDisconnect.addListener(() => {
    if (state.port === port) {
      setError({ code: "disconnected", message: "Lost connection to the extension background. Please try again." });
      done();
    }
  });
  port.postMessage({
    type: "ask",
    pageTexts: state.doc.pageTexts,
    questions: targets.map((q) => ({ text: q.text, web: !!q.web, freeform: !!q.freeform })),
  });
}

// ---------------------------------------------------------------------------
// Matching and highlighting

function matchAnswer(res) {
  return res.quotes.map((q) => matchQuote(state.doc.index, q.text, q.page));
}

function rematchAll() {
  state.matches = {};
  for (const q of state.questions) {
    const res = state.results[q.id];
    if (res) state.matches[q.id] = matchAnswer(res);
  }
  refreshHighlights();
}

// page number -> Map(item index -> [{ start, end, key, color }])
let marksByPage = new Map();

function computeMarks() {
  marksByPage = new Map();
  for (const q of state.questions) {
    (state.matches[q.id] ?? []).forEach((m, qi) => {
      for (const s of m.segments) {
        let items = marksByPage.get(s.page);
        if (!items) marksByPage.set(s.page, (items = new Map()));
        let list = items.get(s.item);
        if (!list) items.set(s.item, (list = []));
        list.push({ start: s.start, end: s.end, key: `${q.id}:${qi}`, color: q.color, low: m.status === "low" });
      }
    });
  }
}

// page number -> { div, spans, touched: Set(item index) }
const painted = new Map();

function onTextLayerRendered({ source, pageNumber }) {
  const div = source?.textLayer?.div;
  if (!div || !state.doc) return;
  const items = state.doc.pages[pageNumber - 1]?.items;
  const dom = [...div.querySelectorAll("span:not(.markedContent):not(.qa-hl):not(.highlight)")];
  // pdf.js creates a span per item but only inserts those with text.
  const expected = items ? items.filter((it) => it.str !== "").length : -1;
  if (dom.length !== expected) {
    console.warn(`Paper Q&A: page ${pageNumber} text layer has ${dom.length} spans, expected ${expected}`);
    return;
  }
  let next = 0;
  const spans = items.map((it) => (it.str === "" ? null : dom[next++]));
  painted.set(pageNumber, { div, spans, touched: new Set() });
  paintPage(pageNumber);
}

function refreshHighlights() {
  computeMarks();
  for (const pageNumber of [...painted.keys()]) paintPage(pageNumber);
}

function paintPage(pageNumber) {
  const entry = painted.get(pageNumber);
  if (!entry) return;
  if (!entry.div.isConnected) {
    painted.delete(pageNumber);
    return;
  }
  const items = state.doc.pages[pageNumber - 1].items;
  const marks = marksByPage.get(pageNumber) ?? new Map();
  for (const i of entry.touched) {
    if (!marks.has(i)) entry.spans[i].textContent = items[i].str;
  }
  entry.touched = new Set(marks.keys());
  for (const [i, list] of marks) paintSpan(entry.spans[i], items[i].str, list);
}

function paintSpan(span, str, list) {
  // Split the span's text at every mark boundary and wrap marked pieces.
  const cuts = new Set([0, str.length]);
  for (const m of list) {
    cuts.add(m.start);
    cuts.add(m.end);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const parts = [];
  for (let k = 0; k < points.length - 1; k++) {
    const a = points[k];
    const b = points[k + 1];
    const text = str.slice(a, b);
    const over = list.filter((m) => m.start <= a && m.end >= b);
    if (!over.length) {
      parts.push(document.createTextNode(text));
      continue;
    }
    const el = document.createElement("span");
    el.className = "qa-hl" + (over.some((m) => m.low) ? " qa-hl-low" : "");
    el.dataset.q = over.map((m) => m.key).join(" ");
    el.style.setProperty("--qa-color", over[0].color);
    if (over.length > 1) el.style.setProperty("--qa-color2", over[1].color);
    el.textContent = text;
    parts.push(el);
  }
  span.replaceChildren(...parts);
}

async function jumpTo(qid, qi) {
  const m = state.matches[qid]?.[qi];
  if (!m?.segments.length) return;
  const page = m.segments[0].page;
  const selector = `.qa-hl[data-q~="${qid}:${qi}"]`;
  const find = () => painted.get(page)?.div.querySelector(selector);
  let el = find();
  if (!el) {
    app.pdfViewer.scrollPageIntoView({ pageNumber: page });
    el = await waitFor(find, 5000);
  }
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  document.querySelectorAll(".qa-flash").forEach((e) => e.classList.remove("qa-flash"));
  void document.body.offsetWidth; // restart the animation
  document.querySelectorAll(selector).forEach((e) => e.classList.add("qa-flash"));
}

function waitFor(fn, timeout) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      const v = fn();
      if (v || performance.now() - t0 > timeout) resolve(v);
      else requestAnimationFrame(tick);
    };
    tick();
  });
}

// ---------------------------------------------------------------------------
// Export

async function doExport() {
  if (!state.doc) return;
  ui.export.disabled = true;
  const before = state.status;
  setStatus("Building annotated PDF…");
  try {
    const highlights = [];
    state.questions.forEach((q, n) => {
      const res = state.results[q.id];
      (state.matches[q.id] ?? []).forEach((m, qi) => {
        if (!m.segments.length) return;
        highlights.push({
          color: q.color,
          segments: m.segments,
          title: `Q${n + 1}`,
          contents: `Q${n + 1}: ${q.text}\n\nA: ${res.answer}${m.status === "low" ? "\n\n(low-confidence match)" : ""}`,
        });
      });
    });
    const out = await exportAnnotated(state.doc.bytes, state.doc.pages, highlights);
    download(new Blob([out], { type: "application/pdf" }), "-annotated.pdf");
    setStatus(before);
  } catch (e) {
    setStatus(before);
    setError({ code: "export", message: `Export failed: ${e.message}` });
  } finally {
    render();
  }
}

function doExportMarkdown() {
  if (!state.doc) return;
  const md = answersToMarkdown({
    name: state.doc.name,
    questions: state.questions,
    results: state.results,
    matches: state.matches,
  });
  download(new Blob([md], { type: "text/markdown;charset=utf-8" }), "-answers.md");
}

function download(blob, suffix) {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: state.doc.name.replace(/\.pdf$/i, "") + suffix });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------------------------------------------------------------------------
// Startup

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.apiKey?.newValue && state.error?.code === "no_key") setError(null);
});

async function main() {
  buildSidebar();
  let open = true;
  try {
    open = localStorage.getItem("qa-sidebar") !== "closed";
  } catch {
    /* storage unavailable */
  }
  if (!open) toggleSidebar(false);
  render();

  await app.initializedPromise;
  initPapers({ app, getDoc: () => state.doc, getSource: () => state.src });
  app.eventBus.on("fileinputchange", () => {
    // A file opened from the toolbar replaces the one named in the address.
    state.src = null;
    history.replaceState(history.state, "", chrome.runtime.getURL("vendor/pdfjs/web/viewer.html"));
  });
  app.eventBus.on("documentloaded", () =>
    onDocumentLoaded().catch((e) => setError({ code: "load", message: `Couldn't read the PDF's text: ${e.message}` })),
  );
  app.eventBus.on("textlayerrendered", onTextLayerRendered);
  app.eventBus.on("pagesedited", () =>
    setError({ code: "edited", message: "Pages were reordered or removed; reload the PDF to keep highlights aligned." }),
  );
  if (app.pdfDocument) onDocumentLoaded();
  else loadFromParam();
}

main();
