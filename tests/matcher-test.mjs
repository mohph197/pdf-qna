// Stress-tests lib/matcher.js against real PDFs.
//
// For each PDF it extracts text items exactly the way the pdf.js text layer
// does, cuts random ground-truth passages out of them, distorts each passage
// the way a model quoting it tends to (typography, dropped citations,
// ellipses, small wording changes, page breaks), and checks that the matcher
// highlights the original characters.
//
//   npm install            # once, installs pdfjs-dist for Node
//   node tests/matcher-test.mjs paper1.pdf [paper2.pdf …]
//
// Set PDFJS_PATH to a pdfjs-dist legacy build to skip npm install.

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { buildIndex, matchQuote, pageText, toKey } from "../lib/matcher.js";

const pdfjsPath = process.env.PDFJS_PATH
  ? pathToFileURL(process.env.PDFJS_PATH).href
  : "pdfjs-dist/legacy/build/pdf.mjs";
const pdfjs = await import(pdfjsPath);

const CASES_PER_KIND = Number(process.env.CASES || 60);
const verbose = process.argv.includes("-v");
const files = process.argv.slice(2).filter((a) => a !== "-v");
if (!files.length) {
  console.error("usage: node tests/matcher-test.mjs file.pdf [...] [-v]");
  process.exit(2);
}

// Deterministic PRNG so failures are reproducible.
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

async function extract(path) {
  const data = new Uint8Array(await readFile(path));
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    // Same parameters the viewer's TextLayerBuilder uses.
    const tc = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
    pages.push({ items: tc.items.filter((it) => it.str !== undefined).map(({ str, hasEOL }) => ({ str, hasEOL })) });
  }
  return pages;
}

function globalItems(pages) {
  const list = [];
  let raw = 0;
  pages.forEach((pg, p) =>
    pg.items.forEach((it, i) => {
      list.push({ p, i, it, raw });
      raw += it.str.length;
    }),
  );
  return list;
}

// A passage of whole items starting at a random item; returns raw range + text.
function samplePassage(items, startIdx, minLen) {
  let text = "";
  let j = startIdx;
  const start = items[startIdx].raw;
  while (j < items.length && text.length < minLen) {
    text += items[j].it.str + (items[j].it.hasEOL ? "\n" : "");
    j++;
  }
  const end = items[j - 1].raw + items[j - 1].it.str.length;
  // Reuse the exact cleanup the model's input goes through.
  return { start, end, text: pageText({ items: [{ str: text, hasEOL: false }] }).replace(/\n/g, " ") };
}

const WORDS = ["model", "results", "approach", "data", "method", "significantly", "task"];
const DISTORT = {
  verbatim: (t) => t,
  typography: (t) =>
    t
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/ﬁ/g, "fi")
      .replace(/ﬂ/g, "fl")
      .replace(/[–—]/g, " - ")
      .replace(/(\w)-(\w)/g, "$1–$2"),
  rawLineBreaks: (t) => t.replace(/ /g, () => (rand() < 0.15 ? "\n" : " ")),
  dropCitations: (t) => t.replace(/\s*\[[\d,;\s–-]+\]/g, "").replace(/(\p{L})\d+\b/gu, "$1"),
  ellipsis: (t) => {
    const words = t.split(" ");
    if (words.length < 12) return t;
    const a = Math.floor(words.length / 3);
    const b = Math.floor((2 * words.length) / 3);
    return [...words.slice(0, a), "...", ...words.slice(b)].join(" ");
  },
  smallEdits: (t) => {
    const words = t.split(" ");
    const n = Math.max(1, Math.round(words.length / 25));
    for (let k = 0; k < n; k++) {
      const i = Math.floor(rand() * words.length);
      if (rand() < 0.5) words.splice(i, 1);
      else words[i] = pick(WORDS);
    }
    return words.join(" ");
  },
};

function overlap(segments, pages, items, truth) {
  const base = new Map();
  for (const g of items) base.set(`${g.p}:${g.i}`, g.raw);
  let covered = 0;
  let total = 0;
  for (const s of segments) {
    const at = base.get(`${s.page - 1}:${s.item}`) + s.start;
    const end = at + (s.end - s.start);
    total += end - at;
    covered += Math.max(0, Math.min(end, truth.end) - Math.max(at, truth.start));
  }
  return { precision: total ? covered / total : 0, recall: covered / (truth.end - truth.start) };
}

let failures = 0;
let totalCases = 0;
for (const file of files) {
  const t0 = Date.now();
  const pages = await extract(file);
  const index = buildIndex(pages);
  const items = globalItems(pages);
  console.log(`\n${file}: ${pages.length} pages, ${items.length} items, key ${index.key.length} chars (index ${Date.now() - t0} ms)`);

  // Candidate starts: items that begin a line with real words.
  const starts = items
    .map((g, k) => k)
    .filter((k) => /^\p{L}{3,}/u.test(items[k].it.str.trim()) && k < items.length - 40);
  // Starts near the bottom of a page so the passage crosses into the next.
  const breakStarts = [];
  for (let p = 0; p < pages.length - 1; p++) {
    const last = items.findLastIndex((g) => g.p === p);
    for (let k = last - 6; k <= last - 2; k++) if (k > 0 && items[k].p === p) breakStarts.push(k);
  }

  const kinds = { ...DISTORT, pageBreak: DISTORT.verbatim };
  for (const [kind, distort] of Object.entries(kinds)) {
    let ok = 0;
    let ambiguous = 0;
    let n = 0;
    const statuses = {};
    let ms = 0;
    for (let c = 0; c < CASES_PER_KIND; c++) {
      const startPool = kind === "pageBreak" ? breakStarts : starts;
      if (!startPool.length) break;
      const truth = samplePassage(items, pick(startPool), 120 + Math.floor(rand() * 250));
      const tKey = toKey(truth.text).key;
      if (tKey.length < 40) continue; // mostly symbols/numbers; not a quotable passage
      n++;
      if (index.key.indexOf(tKey) !== index.key.lastIndexOf(tKey)) ambiguous++;
      const quote = distort(truth.text);
      const hint = items.find((g) => g.raw >= truth.start).p + 1;
      const t1 = performance.now();
      const res = matchQuote(index, quote, hint);
      ms += performance.now() - t1;
      statuses[res.status] = (statuses[res.status] || 0) + 1;
      const { precision, recall } = overlap(res.segments, pages, items, truth);
      // An elided quote legitimately leaves the middle of the passage unhighlighted.
      const minRecall = kind === "ellipsis" ? 0.5 : 0.8;
      if (res.status !== "none" && precision >= 0.9 && recall >= minRecall) ok++;
      else if (verbose || process.env.SHOW_FAILS) {
        console.log(`  FAIL [${kind}] status=${res.status} score=${res.score.toFixed(2)} precision=${precision.toFixed(2)} recall=${recall.toFixed(2)}`);
        console.log(`    quote: ${JSON.stringify(quote.slice(0, 200))}`);
      }
    }
    totalCases += n;
    failures += n - ok;
    const pct = n ? ((100 * ok) / n).toFixed(1) : "-";
    console.log(
      `  ${kind.padEnd(14)} ${String(ok).padStart(3)}/${n} (${pct}%)  ${JSON.stringify(statuses)}` +
        `${ambiguous ? `  ambiguous:${ambiguous}` : ""}  avg ${(ms / Math.max(1, n)).toFixed(1)} ms`,
    );
  }
}
console.log(`\n${totalCases - failures}/${totalCases} passages located (≥90% of highlighted text inside the passage, ≥80% of it covered).`);
process.exit(failures > totalCases * 0.05 ? 1 : 0);
