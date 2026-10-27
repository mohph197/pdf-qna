// Paper previews: clicking a citation shows the cited paper (title, authors,
// venue, citation count, summary, links) in a card, and the toolbar's info
// button shows the same for the open paper. Lookups go through the service
// worker to Semantic Scholar.

import {
  findReferencesStart,
  isCiteDestName,
  isStructuralDestName,
  paperQuery,
  parseReference,
  referenceAt,
} from "../../lib/references.js";
import { getSettings } from "../../shared/models.js";
import { h } from "./dom.js";

const VIEWER = chrome.runtime.getURL("vendor/pdfjs/web/viewer.html");

let app;
let getDoc; // () => state.doc or null
let getSource; // () => the PDF's original URL or null
let enabled = true;
let pop = null; // { el, anchor, kind }
const cache = new Map(); // JSON query -> Promise<paper|null>

export function initPapers(options) {
  ({ app, getDoc, getSource } = options);
  getSettings().then((s) => (enabled = s.citationPreviews));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.citationPreviews) enabled = changes.citationPreviews.newValue !== false;
  });
  addInfoButton();
  // Capture phase, so the card replaces pdf.js's own jump to the reference.
  document.addEventListener("click", onLinkClick, true);
  document.addEventListener("mousedown", (e) => {
    if (pop && !pop.el.contains(e.target) && !pop.anchorEl?.contains(e.target)) closePop();
  });
  document.addEventListener("keydown", (e) => e.key === "Escape" && closePop());
  app.eventBus.on("documentloaded", closePop);
}

// ---------------------------------------------------------------------------
// Lookups

function lookup(query) {
  const key = JSON.stringify(query);
  if (!cache.has(key)) {
    const p = chrome.runtime.sendMessage({ type: "lookupPaper", query }).then((res) => {
      if (!res?.ok) throw Object.assign(new Error(res?.error?.message ?? "Lookup failed."), { code: res?.error?.code });
      return res.paper;
    });
    cache.set(key, p);
    p.catch(() => cache.delete(key)); // errors are worth retrying
  }
  return cache.get(key);
}

// ---------------------------------------------------------------------------
// Citation links

// The destination behind an internal link's href ("…#cite.he2016" or an
// escaped JSON array), or null.
function destFromHref(href) {
  const i = href?.indexOf("#") ?? -1;
  if (i < 0 || i === href.length - 1) return null;
  const hash = unescape(href.slice(i + 1));
  if (hash.startsWith("[")) {
    try {
      return JSON.parse(hash);
    } catch {
      return null;
    }
  }
  return hash.includes("=") ? null : hash; // "page=3&zoom=…" is a view, not a destination
}

function onLinkClick(e) {
  if (!enabled || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest?.(".annotationLayer [data-internal-link] a");
  if (!a || !getDoc()) return;
  const dest = destFromHref(a.getAttribute("href"));
  if (dest == null || isStructuralDestName(dest)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  showCitation(dest, a).catch(() => app.pdfLinkService.goToDestination(dest));
}

async function showCitation(dest, linkEl) {
  const pdf = app.pdfDocument;
  const doc = getDoc();
  const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
  if (!Array.isArray(explicit)) throw new Error("unresolved destination");
  const pageIndex = Number.isInteger(explicit[0]) ? explicit[0] : await pdf.getPageIndex(explicit[0]);
  const [left, top] = destPoint(explicit);
  const ref = referenceAt(doc.pages, pageIndex, left, top);
  // Other links (to a section, figure or footnote) keep their usual behavior.
  // Without a "cite." name, the target must look like a bibliography entry.
  doc.refsStart ??= findReferencesStart(doc.pages) ?? false;
  const looksLikeReference =
    ref &&
    (isCiteDestName(dest) ||
      (doc.refsStart && pageIndex >= doc.refsStart.page && /\b(1[89]|20)\d{2}[a-z]?\b/.test(ref.text) && ref.text.length > 30));
  if (!looksLikeReference) {
    app.pdfLinkService.goToDestination(dest);
    return;
  }
  const query = { ...parseReference(ref.text), context: ref.text };
  const goToReference = () => {
    closePop();
    app.pdfLinkService.goToDestination(dest);
  };
  openPop(linkEl, "cite", () => paperCard(query, { reference: ref.text, goToReference }));
}

function destPoint(explicit) {
  const [, { name } = {}, ...args] = explicit;
  switch (name) {
    case "XYZ":
      return [args[0], args[1]];
    case "FitH":
    case "FitBH":
      return [null, args[0]];
    case "FitR":
      return [args[0], args[3]];
    default:
      return [null, null];
  }
}

// ---------------------------------------------------------------------------
// Toolbar info button

let infoButton;

function addInfoButton() {
  const right = document.getElementById("toolbarViewerRight");
  if (!right) return;
  infoButton = h(
    "button",
    {
      id: "qaInfoButton",
      class: "toolbarButton",
      type: "button",
      title: "Paper info: title, venue, citations",
      "aria-haspopup": "dialog",
      onclick: () => (pop?.kind === "info" ? closePop() : showInfo()),
    },
    h("span", {}, "Paper info"),
  );
  right.prepend(infoButton);
}

async function showInfo() {
  const doc = getDoc();
  if (!doc) {
    openPop(infoButton, "info", () => h("p", { class: "qa-pop-note" }, "Open a PDF to see its details."));
    return;
  }
  const meta = await app.pdfDocument.getMetadata().catch(() => ({}));
  const metadataTitle = meta.metadata?.get?.("dc:title") || meta.info?.Title || "";
  const query = paperQuery({ url: getSource(), pages: doc.pages, metadataTitle });
  if (query.title) query.context = query.title;
  openPop(infoButton, "info", () => paperCard(query, { fallbackTitle: metadataTitle || doc.name }));
}

// ---------------------------------------------------------------------------
// Popover

function openPop(anchorEl, kind, render) {
  closePop();
  const el = h("div", { class: "qa-pop", role: "dialog", "aria-label": kind === "info" ? "Paper info" : "Cited paper" });
  pop = { el, anchorEl, kind };
  if (kind === "info") infoButton?.setAttribute("aria-expanded", "true");
  document.body.append(el);
  el.append(render());
  place();
  // Re-place once content loads and the card changes height.
  new ResizeObserver(() => pop?.el === el && place()).observe(el);
}

function place() {
  const { el, anchorEl } = pop;
  const r = anchorEl.getBoundingClientRect();
  const margin = 8;
  const width = Math.min(440, innerWidth - 2 * margin);
  el.style.setProperty("width", `${width}px`);
  const below = innerHeight - r.bottom - margin;
  const above = r.top - margin;
  const height = el.offsetHeight;
  const top = below >= height || below >= above ? r.bottom + 6 : Math.max(margin, r.top - 6 - height);
  const left = Math.min(Math.max(margin, r.left + r.width / 2 - width / 2), innerWidth - width - margin);
  el.style.setProperty("top", `${Math.round(top)}px`);
  el.style.setProperty("left", `${Math.round(left)}px`);
  el.style.setProperty("max-height", `${Math.max(160, (top > r.top ? below : above) - 6)}px`);
}

function closePop() {
  if (!pop) return;
  pop.el.remove();
  if (pop.kind === "info") infoButton?.setAttribute("aria-expanded", "false");
  pop = null;
}

// ---------------------------------------------------------------------------
// Card

const nf = new Intl.NumberFormat("en-US");
const scholarSearch = (q) => `https://scholar.google.com/scholar?q=${encodeURIComponent(q)}`;
const viewerFor = (pdfUrl) => `${VIEWER}?src=${encodeURIComponent(pdfUrl)}`;
const link = (href, text, title) => h("a", { href, target: "_blank", rel: "noreferrer", title }, text);

function paperCard(query, { reference, goToReference, fallbackTitle } = {}) {
  const root = h("div", { class: "qa-pop-body" });
  const refBlock = reference ? h("p", { class: "qa-pop-ref" }, reference) : null;
  const footer = goToReference
    ? h("div", { class: "qa-pop-actions" }, h("button", { class: "qa-link", type: "button", onclick: goToReference }, "Go to reference ↓"))
    : null;

  const load = () => {
    root.replaceChildren(refBlock ?? "", h("p", { class: "qa-pop-note qa-muted" }, "Looking up on Semantic Scholar…"), footer ?? "");
    const hasQuery = query.doi || query.arxiv || query.acl || query.title;
    (hasQuery ? lookup(query) : Promise.resolve(null)).then(
      (paper) => root.replaceChildren(paper ? paperDetails(paper) : notFound(), footer ?? ""),
      (err) =>
        root.replaceChildren(
          refBlock ?? "",
          h(
            "p",
            { class: "qa-pop-note qa-pop-error" },
            err.message,
            " ",
            h("button", { class: "qa-link", type: "button", onclick: load }, "Retry"),
          ),
          searchLinks(),
          footer ?? "",
        ),
    );
  };

  const searchLinks = () => {
    const q = query.title || fallbackTitle || reference;
    return q ? h("div", { class: "qa-pop-links" }, link(scholarSearch(q), "Search Google Scholar")) : null;
  };

  const notFound = () =>
    h(
      "div",
      {},
      refBlock,
      h(
        "p",
        { class: "qa-pop-note qa-muted" },
        reference
          ? "This reference wasn't found on Semantic Scholar."
          : "Couldn't identify this paper on Semantic Scholar.",
      ),
      searchLinks(),
    );

  load();
  return root;
}

function paperDetails(p) {
  const authors = p.authors.length > 8 ? [...p.authors.slice(0, 7), `${p.authors.length - 7} more`] : p.authors;
  const venue = [p.venue && p.venueShort && !p.venue.includes(p.venueShort) ? `${p.venue} (${p.venueShort})` : p.venue, p.year]
    .filter(Boolean)
    .join(" · ");
  const pdfUrl = p.arxiv ? `https://arxiv.org/pdf/${p.arxiv}` : /\.pdf($|\?)/i.test(p.pdf ?? "") ? p.pdf : null;
  const stats = [
    p.citations != null && link(`${p.url}#citing-papers`, `Cited by ${nf.format(p.citations)}`, "Papers citing this one, on Semantic Scholar"),
    p.influential ? h("span", { title: "Citations Semantic Scholar rates as influential" }, `${nf.format(p.influential)} influential`) : null,
    p.references != null && h("span", {}, `${nf.format(p.references)} references`),
  ].filter(Boolean);
  return h(
    "div",
    { class: "qa-paper" },
    h("h3", { class: "qa-paper-title" }, link(p.url, p.title, "Open on Semantic Scholar")),
    authors.length ? h("p", { class: "qa-paper-authors" }, authors.join(", ")) : null,
    venue ? h("p", { class: "qa-paper-venue" }, venue) : null,
    stats.length ? h("p", { class: "qa-paper-stats" }, stats.flatMap((s, i) => (i ? [" · ", s] : [s]))) : null,
    p.tldr ? h("p", { class: "qa-paper-tldr" }, h("b", {}, "TL;DR "), p.tldr) : null,
    p.abstract ? h("details", { class: "qa-paper-abstract" }, h("summary", {}, "Abstract"), h("p", {}, p.abstract)) : null,
    h(
      "div",
      { class: "qa-pop-links" },
      link(scholarSearch(p.title), "Google Scholar"),
      link(p.url, "Semantic Scholar"),
      p.arxiv ? link(`https://arxiv.org/abs/${p.arxiv}`, "arXiv") : null,
      p.doi ? link(`https://doi.org/${p.doi}`, "DOI") : null,
      p.pdf ? link(p.pdf, "PDF") : null,
      pdfUrl ? link(viewerFor(pdfUrl), "Open in Paper Q&A", "Open this paper's PDF in a new Paper Q&A tab") : null,
      p.bibtex
        ? h("button", { class: "qa-link", type: "button", onclick: (e) => copy(e.currentTarget, p.bibtex, "Copy BibTeX") }, "Copy BibTeX")
        : null,
    ),
    h("p", { class: "qa-pop-source" }, "Data from Semantic Scholar"),
  );
}

async function copy(button, text, label) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Copy failed";
  }
  setTimeout(() => (button.textContent = label), 1500);
}
