// Paper previews: clicking a citation shows the cited paper (title, authors,
// venue, citation count, summary, links) in a card, and the toolbar's info
// button shows the same for the open paper. Lookups go through the service
// worker (Semantic Scholar, Crossref, OpenAlex, arXiv). Hovering a citation
// starts its lookup, so the card is usually ready by the time it's clicked.
// In PDFs whose citations aren't links, plain-text numbered citations ("[12]")
// work the same way. For citations cited together ("[2], [50]", "[23]–[25]",
// "(He et al., 2016; Ma, 2017)") the card steps through the whole group.

import {
  citationGroups,
  findReferencesStart,
  isCiteDestName,
  isStructuralDestName,
  numberedCitations,
  numberedReference,
  pageLines,
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
let pop = null; // { el, anchorEl, kind, step? }
const cache = new Map(); // JSON query -> Promise<paper|null>
const citations = new Map(); // JSON destination -> Promise<{ ref, query } | null>
const CITE_LINK = ".annotationLayer [data-internal-link] a";
const TEXT_SPAN = ".textLayer span:not(.markedContent):not(.qa-hl):not(.highlight)";

export function initPapers(options) {
  ({ app, getDoc, getSource } = options);
  getSettings().then((s) => (enabled = s.citationPreviews));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.citationPreviews) enabled = changes.citationPreviews.newValue !== false;
  });
  addInfoButton();
  // Capture phase, so the card replaces pdf.js's own jump to the reference.
  document.addEventListener("click", onLinkClick, true);
  document.addEventListener("pointerover", onLinkHover);
  document.addEventListener("pointermove", onTextHover);
  document.addEventListener("mousedown", (e) => {
    if (pop && !pop.el.contains(e.target) && !pop.anchorEl?.contains(e.target)) closePop();
  });
  document.addEventListener("keydown", (e) => e.key === "Escape" && closePop());
  // Capture phase, so pdf.js doesn't also turn the page.
  document.addEventListener(
    "keydown",
    (e) => {
      const d = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
      if (!d || !pop?.step || e.altKey || e.ctrlKey || e.metaKey || e.target.closest?.("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      e.stopPropagation();
      pop.step(d);
    },
    true,
  );
  app.eventBus.on("documentloaded", () => {
    closePop();
    citations.clear();
  });
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

// The destination of a link that may be a citation, or null.
function citationDest(target) {
  const a = target.closest?.(CITE_LINK);
  if (!a || !enabled || !getDoc()) return null;
  const dest = destFromHref(a.getAttribute("href"));
  return dest == null || isStructuralDestName(dest) ? null : { a, dest };
}

function onLinkClick(e) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const link = citationDest(e.target);
  if (!link) {
    // Plain text has no default action to replace; a drag selects text.
    const cite = getSelection().isCollapsed && textCitation(e);
    if (cite) {
      const members = cite.group.map((n) => ({ dest: { numbered: n }, label: String(n) }));
      showCitation(members, cite.index, cite.anchor).catch(() => {});
    }
    return;
  }
  e.preventDefault();
  e.stopImmediatePropagation();
  let group = null;
  try {
    group = linkGroup(link);
  } catch {} // without its group, the card still shows this citation
  const members = group?.members ?? [{ dest: link.dest }];
  showCitation(members, group?.index ?? 0, link.a).catch(() => app.pdfLinkService.goToDestination(link.dest));
}

let hoverTimer = null;
function onLinkHover(e) {
  clearTimeout(hoverTimer);
  const link = citationDest(e.target);
  if (!link) return;
  // A short dwell, so sweeping the pointer across a page doesn't look up
  // every citation it crosses.
  hoverTimer = setTimeout(() => {
    resolveCitation(link.dest)
      .then((cite) => cite && lookup(cite.query))
      .catch(() => {});
  }, 150);
}

// Show the card for members[index], a citation in a group of citations
// ([{ dest, label? }]) that the card can step through.
async function showCitation(members, index, linkEl) {
  const { dest } = members[index];
  const cite = await resolveCitation(dest);
  // Other links (to a section, figure or footnote) keep their usual behavior.
  if (!cite) {
    app.pdfLinkService.goToDestination(dest);
    return;
  }
  // Group members that lead to a bibliography entry, each entry once.
  const resolved = await Promise.all(members.map((m, i) => (i === index ? cite : resolveCitation(m.dest).catch(() => null))));
  const entries = [];
  members.forEach((m, i) => {
    const c = resolved[i];
    if (c && !entries.some((e) => e.cite.ref.text === c.ref.text)) entries.push({ ...m, cite: c });
  });
  const at = entries.findIndex((e) => e.cite.ref.text === cite.ref.text);
  openPop(linkEl, "cite", () => citationCard(entries, at));
}

function citationCard(entries, index) {
  const card = (entry) =>
    paperCard(entry.cite.query, {
      reference: entry.cite.ref.text,
      goToReference: () => {
        closePop();
        app.pdfLinkService.goToDestination(entry.cite.goTo ?? entry.dest);
      },
    });
  if (entries.length < 2) return card(entries[0]);

  const body = h("div", {});
  const counter = h("span", { class: "qa-pop-count", "aria-live": "polite" });
  const stepButton = (d, text, title) =>
    h("button", { class: "qa-pop-step", type: "button", title, "aria-label": title, onclick: () => show(index + d) }, text);
  const prev = stepButton(-1, "‹", "Previous cited paper (←)");
  const next = stepButton(1, "›", "Next cited paper (→)");
  const show = (i) => {
    if (i < 0 || i >= entries.length) return;
    index = i;
    const { label } = entries[i];
    const name = !label ? "" : /^\d+$/.test(label) ? `[${label}]` : label;
    counter.textContent = `${name ? `${name} · ` : ""}${i + 1} of ${entries.length}`;
    prev.disabled = i === 0;
    next.disabled = i === entries.length - 1;
    body.replaceChildren(card(entries[i]));
    // The neighbours are likely next.
    for (const e of [entries[i - 1], entries[i + 1]]) e && lookup(e.cite.query).catch(() => {});
  };
  pop.step = (d) => show(index + d);
  show(index);
  return h("div", {}, h("div", { class: "qa-pop-nav" }, prev, counter, next), body);
}

// The group of citation links cited together with `link` ("[2], [50]",
// "[23]–[25]"), as { members: [{ dest, label }], index }, or null. Works from
// the text layer: the text inside each link and the text between links.
function linkGroup(link) {
  const pageDiv = link.a.closest(".page");
  const spans = [...(pageDiv?.querySelectorAll(TEXT_SPAN) ?? [])];
  if (!spans.length) return null;
  const links = [...pageDiv.querySelectorAll(CITE_LINK)]
    .map((a) => (a === link.a ? link : citationDest(a)))
    .filter(Boolean)
    .map((l) => ({ ...l, rect: l.a.getBoundingClientRect() }));
  const self = links.findIndex((l) => l.a === link.a);
  const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const inside = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  const spanRects = spans.map((s) => s.getBoundingClientRect());
  const near = spanRects.flatMap((r, i) => (overlaps(r, links[self].rect) ? [i] : []));
  if (!near.length) return null;

  // The text a few lines around the link, in reading order, split into the
  // characters inside each link and the rest.
  const segments = [];
  for (let i = Math.max(0, near[0] - 30); i < Math.min(spans.length, near.at(-1) + 31); i++) {
    const text = spans[i].textContent;
    const eol = spans[i].nextSibling?.nodeName === "BR" ? " " : "";
    const candidates = links.filter((l) => overlaps(l.rect, spanRects[i]));
    if (!candidates.length) {
      segments.push({ text: text + eol });
      continue;
    }
    for (let c = 0; c < text.length; c++) {
      const r = textRange(spans[i], c, c + 1).getBoundingClientRect();
      const hit = candidates.find((l) => inside(l.rect, r.left + r.width / 2, r.top + r.height / 2));
      segments.push({ text: text[c], key: hit ? links.indexOf(hit) : undefined });
    }
    if (eol) segments.push({ text: eol });
  }
  const group = citationGroups(segments).find((g) => g.some((m) => m.key === self));
  if (!group || group.length < 2) return null;
  return {
    members: group.map((m) => (m.key == null ? { dest: { numbered: m.n }, label: m.label } : { dest: links[m.key].dest, label: m.label })),
    index: group.findIndex((m) => m.key === self),
  };
}

function resolveCitation(dest) {
  const key = JSON.stringify(dest);
  if (!citations.has(key)) citations.set(key, findCitation(dest));
  return citations.get(key);
}

// The bibliography entry a citation link points to and its lookup query, or
// null when the link isn't a citation.
async function findCitation(dest) {
  const pdf = app.pdfDocument;
  const doc = getDoc();
  if (dest.numbered) {
    const ref = numberedRef(doc, dest.numbered);
    if (!ref) return null;
    return { ref, query: { ...parseReference(ref.text), context: ref.text }, goTo: [ref.page, { name: "XYZ" }, ref.x, ref.y, null] };
  }
  const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
  if (!Array.isArray(explicit)) throw new Error("unresolved destination");
  const pageIndex = Number.isInteger(explicit[0]) ? explicit[0] : await pdf.getPageIndex(explicit[0]);
  const [left, top] = destPoint(explicit);
  const ref = referenceAt(doc.pages, pageIndex, left, top);
  // Without a "cite." name, the target must look like a bibliography entry.
  const refsStart = referencesStart(doc);
  const looksLikeReference =
    ref &&
    (isCiteDestName(dest) ||
      (refsStart && pageIndex >= refsStart.page && /\b(1[89]|20)\d{2}[a-z]?\b/.test(ref.text) && ref.text.length > 30));
  return looksLikeReference ? { ref, query: { ...parseReference(ref.text), context: ref.text } } : null;
}

// Where the references section starts ({ page, line, item }), or false.
function referencesStart(doc) {
  if (doc.refsStart === undefined) {
    const start = findReferencesStart(doc.pages);
    doc.refsStart = start ? { ...start, item: pageLines(doc.pages[start.page].items)[start.line].start } : false;
  }
  return doc.refsStart;
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
// Unlinked numbered citations

function numberedRef(doc, n) {
  doc.numberedRefs ??= new Map();
  if (!doc.numberedRefs.has(n)) doc.numberedRefs.set(n, numberedReference(doc.pages, n, referencesStart(doc)));
  return doc.numberedRefs.get(n);
}

const spanItems = new WeakMap(); // text-layer span -> text-content item index

// Span i is item i, but pdf.js leaves out items with empty strings.
function spanItem(span, items) {
  if (!spanItems.has(span)) {
    const dom = span.closest(".textLayer").querySelectorAll(TEXT_SPAN);
    if (dom.length !== items.filter((it) => it.str !== "").length) return null;
    let next = 0;
    items.forEach((it, i) => it.str !== "" && spanItems.set(dom[next++], i));
  }
  return spanItems.get(span);
}

// The plain-text numbered citation under the pointer, as { dest, span,
// anchor }, or null. Only before the references section, on pages without
// citation links of their own, and when the bibliography has that entry.
function textCitation(e) {
  const span = e.target.closest?.(TEXT_SPAN);
  const doc = getDoc();
  if (!span || !enabled || !doc) return null;
  const pageDiv = span.closest(".page");
  const pageIndex = Number(pageDiv?.dataset.pageNumber) - 1;
  const refsStart = referencesStart(doc);
  const items = doc.pages[pageIndex]?.items;
  if (!refsStart || !items || pageIndex > refsStart.page) return null;
  const item = spanItem(span, items);
  if (item == null || (pageIndex === refsStart.page && item >= refsStart.item)) return null;

  const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
  if (!pos || !span.contains(pos.offsetNode)) return null;
  const before = document.createRange();
  before.setStart(span, 0);
  before.setEnd(pos.offsetNode, pos.offset);
  const offset = before.toString().length;
  doc.textCites ??= [];
  doc.textCites[pageIndex] ??= numberedCitations(items);
  const cite = doc.textCites[pageIndex].find((c) => c.item === item && c.start <= offset && offset <= c.end);
  if (!cite || !numberedRef(doc, cite.n)) return null;
  if ([...pageDiv.querySelectorAll(CITE_LINK)].some((a) => citationDest(a))) return null;

  const range = textRange(span, cite.start, cite.end);
  const rect = range.getBoundingClientRect();
  return { dest: { numbered: cite.n }, group: cite.group, index: cite.index, span, anchor: { getBoundingClientRect: () => rect, contains: (node) => span.contains(node) } };
}

// A range over characters start..end of an element's text, which highlights
// may have split into several text nodes.
function textRange(el, start, end) {
  const range = document.createRange();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let at = 0;
  let started = false;
  for (let node; (node = walker.nextNode()); at += node.length) {
    if (!started && start <= at + node.length) {
      range.setStart(node, start - at);
      started = true;
    }
    if (started && end <= at + node.length) {
      range.setEnd(node, end - at);
      break;
    }
  }
  return range;
}

let textHover = null; // { span, key } of the citation under the pointer
let textHoverTimer = null;
function onTextHover(e) {
  const cite = !e.buttons && e.target.closest?.(".textLayer") ? textCitation(e) : null;
  const key = cite && JSON.stringify(cite.dest);
  if (key === (textHover?.key ?? null)) return;
  textHover?.span.classList.remove("qa-cite-text");
  clearTimeout(textHoverTimer);
  textHover = cite && { span: cite.span, key };
  if (!cite) return;
  cite.span.classList.add("qa-cite-text");
  textHoverTimer = setTimeout(() => {
    resolveCitation(cite.dest)
      .then((c) => c && lookup(c.query))
      .catch(() => {});
  }, 150);
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
    root.replaceChildren(refBlock ?? "", h("p", { class: "qa-pop-note qa-muted" }, "Looking up the paper…"), footer ?? "");
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
          ? "This reference wasn't found on Semantic Scholar, OpenAlex, Crossref or arXiv."
          : "Couldn't identify this paper on Semantic Scholar, OpenAlex, Crossref or arXiv.",
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
    p.citations != null &&
      (p.citationsUrl
        ? link(p.citationsUrl, `Cited by ${nf.format(p.citations)}`, `Papers citing this one, on ${p.source}`)
        : h("span", {}, `Cited by ${nf.format(p.citations)}`)),
    p.influential ? h("span", { title: "Citations Semantic Scholar rates as influential" }, `${nf.format(p.influential)} influential`) : null,
    p.references != null && h("span", {}, `${nf.format(p.references)} references`),
  ].filter(Boolean);
  return h(
    "div",
    { class: "qa-paper" },
    h("h3", { class: "qa-paper-title" }, link(p.url, p.title, `Open on ${p.source}`)),
    authors.length ? h("p", { class: "qa-paper-authors" }, authors.join(", ")) : null,
    venue ? h("p", { class: "qa-paper-venue" }, venue) : null,
    stats.length ? h("p", { class: "qa-paper-stats" }, stats.flatMap((s, i) => (i ? [" · ", s] : [s]))) : null,
    p.tldr ? h("p", { class: "qa-paper-tldr" }, h("b", {}, "TL;DR "), p.tldr) : null,
    p.abstract ? h("details", { class: "qa-paper-abstract" }, h("summary", {}, "Abstract"), h("p", {}, p.abstract)) : null,
    h(
      "div",
      { class: "qa-pop-links" },
      link(scholarSearch(p.title), "Google Scholar"),
      p.source === "Crossref" ? null : link(p.url, p.source), // a Crossref result's page is its DOI
      p.arxiv ? link(`https://arxiv.org/abs/${p.arxiv}`, "arXiv") : null,
      p.doi ? link(`https://doi.org/${p.doi}`, "DOI") : null,
      p.pdf ? link(p.pdf, "PDF") : null,
      pdfUrl ? link(viewerFor(pdfUrl), "Open in Paper Q&A", "Open this paper's PDF in a new Paper Q&A tab") : null,
      p.bibtex
        ? h("button", { class: "qa-link", type: "button", onclick: (e) => copy(e.currentTarget, p.bibtex, "Copy BibTeX") }, "Copy BibTeX")
        : null,
    ),
    h("p", { class: "qa-pop-source" }, `Data from ${p.source}`),
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
