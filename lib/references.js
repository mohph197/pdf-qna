// Reference and paper identification helpers (pure ES module, also runs in
// Node). The viewer uses them to turn a clicked citation into the text of the
// bibliography entry it points to, and that text, or the open PDF, into a
// query for a paper lookup.
//
// `pages` is the viewer's extracted text: pages[i].items are pdf.js
// text-content items ({ str, hasEOL, transform, width, height }), in content
// stream order, which LaTeX writes in reading order.

const REFERENCES_HEADING = /^(?:[\dIVX]+\.?\s*)?(?:references|bibliography|literature\s+cited|works\s+cited)$/i;

// Named destinations that are internal structure, never bibliography entries.
const NOT_A_CITATION = /^(?:section|subsection|subsubsection|paragraph|chapter|appendix|part|figure|subfigure|table|subtable|equation|eq|page|hfootnote|footnote|item|algorithm|algocf|alg|lstlisting|listing|theorem|lemma|corollary|proposition|definition|remark|example|assumption|hypothesis|claim|note|doc-start|toc|outline|nameddest)/i;

/** True when a named destination is a LaTeX/hyperref citation target. */
export function isCiteDestName(name) {
  return typeof name === "string" && /^cite[.:]/i.test(name);
}

/** True when a named destination certainly isn't a citation (section, figure…). */
export function isStructuralDestName(name) {
  return typeof name === "string" && NOT_A_CITATION.test(name);
}

/** Group a page's items into lines: [{ x, y, size, start, end, text }]. */
export function pageLines(items) {
  const lines = [];
  let cur = null;
  items.forEach((it, i) => {
    if (!cur) cur = { start: i, end: i + 1, parts: [] };
    cur.end = i + 1;
    cur.parts.push(it.str);
    if (it.str.trim() && cur.x === undefined) {
      cur.x = it.transform[4];
      cur.y = it.transform[5];
      cur.size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 0;
    }
    if (it.hasEOL || i === items.length - 1) {
      if (cur.x !== undefined) lines.push({ x: cur.x, y: cur.y, size: cur.size, start: cur.start, end: cur.end, text: cur.parts.join("") });
      cur = null;
    }
  });
  return lines;
}

/**
 * Where the references section starts: { page, line } (0-based), or null.
 * The last matching heading wins, so a "References" mention in the table of
 * contents doesn't count.
 */
export function findReferencesStart(pages) {
  for (let p = pages.length - 1; p >= 0; p--) {
    const lines = pageLines(pages[p].items);
    for (let l = lines.length - 1; l >= 0; l--) {
      if (REFERENCES_HEADING.test(lines[l].text.trim())) return { page: p, line: l };
    }
  }
  return null;
}

/**
 * The text of the bibliography entry at a destination. `left`/`top` are the
 * destination's PDF coordinates (an XYZ destination's anchor sits at, or just
 * above, the top of the entry's first line). Returns { text, page } or null.
 */
export function referenceAt(pages, pageIndex, left, top) {
  const lines = pageLines(pages[pageIndex]?.items ?? []);
  if (!lines.length) return null;
  // The first line below the anchor, in the anchor's column. Some templates
  // (ICLR's natbib setup) put the anchor in the left margin, 25pt before the
  // entry, so allow more room on that side.
  let first = -1;
  lines.forEach((ln, i) => {
    if (left != null && (ln.x - left > 40 || left - ln.x > 20)) return;
    if (top != null && (ln.y >= top - 1 || top - ln.y > 40)) return;
    if (first < 0 || ln.y > lines[first].y || (ln.y === lines[first].y && i < first)) first = i;
  });
  if (first < 0) return null;
  return entryFrom(pages, pageIndex, lines, first);
}

// Whether a line starts with a "[12]" or "12." label.
const LABEL = /^\s*(\[[^\]]{1,12}\]|\d{1,3}\.\s)/;

// The bibliography entry whose first line is lines[first] on pages[pageIndex].
function entryFrom(pages, pageIndex, lines, first) {
  const startX = lines[first].x;
  const lineGap = lines[first].size * 1.25 || 12;
  const parts = [lines[first].text];
  const labelled = LABEL.test(lines[first].text);
  let contX = null; // x of continuation lines in the current column
  let prev = lines[first];
  let p = pageIndex;
  let i = first + 1;
  let pageLinesList = lines;
  for (let n = 0; n < 12 && parts.join(" ").length < 700; n++) {
    if (i >= pageLinesList.length) {
      // The entry may continue on the next page.
      if (++p >= pages.length) break;
      pageLinesList = pageLines(pages[p].items);
      i = 0;
      if (!pageLinesList.length) break;
      prev = null;
    }
    const ln = pageLinesList[i++];
    const newColumn = !prev || ln.y > prev.y + 1 || Math.abs(ln.x - prev.x) > 60;
    if (newColumn) {
      // A continuation at the top of the next column or page: skip running
      // headers and page numbers, then treat the first line as continuation.
      if (/^\s*\d{1,4}\s*$/.test(ln.text)) continue;
      if (labelled && LABEL.test(ln.text)) break;
      // With hanging indents, a line at the new column's flush margin starts
      // the next entry: the previous one ended at the bottom of its column.
      if (!labelled) {
        const col = [ln];
        for (let k = i; k < pageLinesList.length && col.length < 8; k++) {
          const next = pageLinesList[k];
          if (next.y > col.at(-1).y + 1 || Math.abs(next.x - ln.x) > 60) break;
          col.push(next);
        }
        const flushX = Math.min(...col.map((l) => l.x));
        if (ln.x <= flushX + 1 && col.some((l) => l.x > flushX + 2)) break;
      }
      contX = ln.x;
    } else {
      if (labelled && LABEL.test(ln.text)) break;
      if (prev.y - ln.y > lineGap * 1.6) break; // blank line between entries
      if (contX === null) {
        // Hanging indent: continuation lines sit right of the entry's start.
        if (ln.x <= startX + 1 && !labelled) break;
        contX = ln.x;
      } else if (ln.x < contX - 2) {
        break; // back at the flush margin: the next entry
      }
    }
    parts.push(ln.text);
    prev = ln;
  }
  return { text: cleanText(parts.join("\n")), page: pageIndex };
}

// "[7]", "[20,21]", "[3–9]", "[7, 23–27]": a bracketed list of numbers and ranges.
const NUMBERED_CITE = /\[\s*\d{1,3}(?:\s*[–-]\s*\d{1,3})?(?:\s*,\s*\d{1,3}(?:\s*[–-]\s*\d{1,3})?)*\s*\]/g;

/**
 * Numbered citations written as plain text, for PDFs whose citations aren't
 * links. Returns one { n, item, start, end } per number, with offsets into
 * items[item].str. Like hyperref, a range "[3–9]" yields its two ends. A
 * citation may run across items ("[11–" at a line end, then "19]").
 */
export function numberedCitations(items) {
  const starts = [];
  let text = "";
  for (const it of items) {
    starts.push(text.length);
    text += it.str;
  }
  const out = [];
  for (const m of text.matchAll(NUMBERED_CITE)) {
    for (const d of m[0].matchAll(/\d+/g)) {
      const at = m.index + d.index;
      let item = starts.length - 1;
      while (starts[item] > at) item--;
      const start = at - starts[item];
      out.push({ n: Number(d[0]), item, start, end: Math.min(start + d[0].length, items[item].str.length) });
    }
  }
  return out;
}

/**
 * The bibliography entry labelled "[n]" in the references section starting
 * at `refsStart` (from findReferencesStart). Returns { text, page, x, y }
 * with the entry's first line position, or null.
 */
export function numberedReference(pages, n, refsStart) {
  if (!refsStart) return null;
  const label = new RegExp(`^\\s*\\[${n}\\]`);
  for (let p = refsStart.page; p < pages.length; p++) {
    const lines = pageLines(pages[p].items);
    const first = lines.findIndex((ln, i) => (p > refsStart.page || i > refsStart.line) && label.test(ln.text));
    if (first >= 0) return { ...entryFrom(pages, p, lines, first), x: lines[first].x, y: lines[first].y + lines[first].size };
  }
  return null;
}

/** Join extracted lines: undo end-of-line hyphenation and squash whitespace. */
export function cleanText(text) {
  return text
    .normalize("NFKC")
    .replace(/(\p{Ll})-\n(\p{Ll})/gu, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

const DOI = /\b(10\.\d{4,9}\/[^\s"<>]+)/i;
const ARXIV = /(?:arxiv(?:\.org\/(?:abs|pdf)\/|\s*:\s*|\s+preprint\s+(?:arxiv\s*:\s*)?)|\babs\/)(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?/i;

function trimDoi(doi) {
  return doi.replace(/[.,;:)\]}]+$/, "");
}

/**
 * Parse a bibliography entry into a lookup query: { doi?, arxiv?, title? }.
 * The title guess takes the first sentence after the author list, skipping a
 * year, or a quoted title when there is one.
 */
export function parseReference(text) {
  const body = text.replace(/^\s*(?:\[[^\]]{1,12}\]|\d{1,3}\.)\s*/, "").trim();
  const out = {};
  const doi = body.match(DOI);
  if (doi) out.doi = trimDoi(doi[1]);
  const arxiv = body.match(ARXIV);
  if (arxiv) out.arxiv = arxiv[1];
  const quoted = body.match(/[“"]([^”"]{12,300}?)[,.]?[”"]/);
  if (quoted) {
    out.title = quoted[1].trim();
    return out;
  }
  // Split at sentence ends, but not after an initial ("K. He") or an
  // abbreviation, and only where a new sentence starts.
  const sentences = body
    .split(/(?<![\s.\-‐–][A-Z]|^[A-Z]|\bvol|\bno|\bpp|\bEds?|\bJr|\bSt)[.?!]\s+(?=[\p{Lu}\d"“(\[]|arXiv|https?:)/u)
    .map((s) => s.trim())
    .filter(Boolean);
  for (let k = 1; k < sentences.length; k++) {
    const s = sentences[k].replace(/[.,]$/, "");
    if (/^\(?\d{4}[a-z]?\)?$/.test(s)) continue; // "2018." in ACL style
    if (/^(?:In\b|Proc\b|Proceedings\b|arXiv\b|CoRR\b|URL\b|https?:)/i.test(s)) break;
    if (s.split(/\s+/).length < 2) continue;
    out.title = s.replace(/^\(?\d{4}[a-z]?\)?[.,:]?\s+/, "");
    break;
  }
  return out;
}

/** Paper identifiers in a URL: { doi?, arxiv?, acl? }. */
export function idsFromUrl(url) {
  const out = {};
  let u;
  try {
    u = new URL(url);
  } catch {
    return out;
  }
  const path = decodeURIComponent(u.pathname);
  const host = u.hostname.replace(/^www\./, "");
  if (/(^|\.)arxiv\.org$/.test(host)) {
    const m = path.match(/^\/(?:abs|pdf|html)\/(.+?)(?:v\d+)?(?:\.pdf)?\/?$/);
    if (m) out.arxiv = m[1];
  } else if (host === "aclanthology.org") {
    const m = path.match(/^\/([A-Z0-9][\w.-]+?)(?:\.pdf)?\/?$/i);
    if (m) out.acl = m[1];
  } else if (host === "doi.org" || host === "dx.doi.org") {
    const m = path.match(/^\/(10\.\d{4,9}\/.+)$/);
    if (m) out.doi = m[1];
  } else {
    // Publisher PDF URLs often embed the DOI: …/content/pdf/10.1007/s11263-015-0816-y.pdf
    const m = (path + u.search).match(DOI);
    if (m) out.doi = trimDoi(m[1].replace(/\.pdf$/i, ""));
  }
  return out;
}

/**
 * A lookup query for the open paper: identifiers from its URL, or else an
 * arXiv stamp or DOI on the first page, plus a title from the PDF metadata
 * or the largest text on the first page. With both, a lookup can find the
 * published version of an arXiv preprint by its title.
 */
export function paperQuery({ url, pages, metadataTitle }) {
  const first = pages[0] ? pageLines(pages[0].items) : [];
  const title = usableTitle(metadataTitle) ?? titleFromLayout(first);
  const query = url ? idsFromUrl(url) : {};
  if (!query.arxiv && !query.acl && !query.doi) {
    const firstText = first.map((l) => l.text).join("\n");
    // arXiv stamps every page's margin with "arXiv:1512.03385v1 [cs.CV] 10 Dec 2015".
    const stamp = firstText.match(/arXiv:(\d{4}\.\d{4,5})(?:v\d+)?\s*\[/);
    const doi = firstText.match(/(?:doi(?:\.org\/|:\s*)|DOI\s+)(10\.\d{4,9}\/\S+)/i);
    if (stamp) query.arxiv = stamp[1];
    else if (doi) query.doi = trimDoi(doi[1]);
  }
  if (title) query.title = title;
  return query;
}

function usableTitle(t) {
  if (!t) return null;
  t = t.replace(/\s+/g, " ").trim();
  if (t.split(" ").length < 3 || t.length > 300) return null;
  if (/^(untitled|microsoft word|title)\b|\.(docx?|tex|dvi|pdf)$|^[\w-]+$/i.test(t)) return null;
  return t;
}

// The paper title is usually the largest text in the top half of page one.
function titleFromLayout(lines) {
  const top = lines.filter((l) => /\p{L}{2}/u.test(l.text) && l.size > 0);
  if (!top.length) return null;
  const highest = Math.max(...top.map((l) => l.y));
  const candidates = top.filter((l) => l.y > highest - 400 && !/arxiv:/i.test(l.text));
  if (!candidates.length) return null;
  const max = Math.max(...candidates.map((l) => l.size));
  const title = candidates.filter((l) => l.size >= max - 0.5).sort((a, b) => b.y - a.y);
  // Title lines are contiguous; stop at the first big vertical jump.
  const kept = [title[0]];
  for (const l of title.slice(1)) {
    if (kept.at(-1).y - l.y > max * 2.2) break;
    kept.push(l);
  }
  return usableTitle(cleanText(kept.map((l) => l.text).join("\n")));
}

const words = (s) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1);

/**
 * Whether a found paper's title fits the text it was looked up from (a
 * reference entry or a title guess). The title must occur in the text as a
 * whole (ignoring case, punctuation, spacing and hyphenation), or else all
 * its words must occur, with one allowed missing from a long title. So
 * "Deep Residual Learning for Image Recognition: A Survey" doesn't fit a
 * reference to "Deep residual learning for image recognition".
 */
export function titleFits(foundTitle, text) {
  const t = words(foundTitle ?? "");
  if (!t.length) return false;
  const key = t.join("");
  if (key.length >= 10 && words(text ?? "").join("").includes(key)) return true;
  const have = new Set(words(text ?? ""));
  const missing = t.filter((w) => !have.has(w)).length;
  return missing <= (t.length >= 8 ? 1 : 0);
}
