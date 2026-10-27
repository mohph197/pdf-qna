// Quote matcher: finds model-supplied quotes in the PDF text layer.
//
// Both the document and each quote are reduced to a "key": NFKC-normalized,
// accent-stripped, lower-cased letters and digits only. Whitespace, line
// breaks, hyphens (including line-end hyphenation), quotes, dashes and other
// punctuation simply vanish, so they can never cause a mismatch. Every key
// character remembers the raw text-layer position it came from, which lets a
// match in key space be mapped back onto exact characters inside the spans.
//
// Matching runs in tiers: exact key match, then a letters-only match (ignores
// citation numbers/footnote markers the model dropped), then a fuzzy
// alignment around candidate regions found by k-gram voting.
//
// Pure ES module with no DOM access, so it runs in the viewer and in Node tests.

const KEEP = /[\p{L}\p{N}]/u;
const MARKS = /\p{M}/gu;
// Characters NFKC leaves alone but that PDFs from LaTeX commonly produce.
const EXTRA_FOLD = { "ı": "i", "ȷ": "j", "ß": "ss", "æ": "ae", "œ": "oe", "ø": "o", "ł": "l", "đ": "d" };

const TRAILING = /[.,;:!?%)\]}”’"']/;

const foldCache = new Map();

/** Fold a single code point to its key characters ("" if it carries no letters/digits). */
function foldCodePoint(cp) {
  let out = foldCache.get(cp);
  if (out !== undefined) return out;
  const decomposed = cp.normalize("NFKC").normalize("NFD").replace(MARKS, "").toLowerCase();
  out = "";
  for (const ch of decomposed) {
    const mapped = EXTRA_FOLD[ch] ?? ch;
    for (const c of mapped) if (KEEP.test(c)) out += c;
  }
  foldCache.set(cp, out);
  return out;
}

/**
 * Normalize an arbitrary string to key form.
 * Returns { key, map } where map[i] is the code-unit offset in `text` of key[i].
 */
export function toKey(text) {
  let key = "";
  const map = [];
  let offset = 0;
  for (const cp of text) {
    const folded = foldCodePoint(cp);
    for (let i = 0; i < folded.length; i++) map.push(offset);
    key += folded;
    offset += cp.length;
  }
  return { key, map };
}

/**
 * Build the searchable index for a document.
 * @param {Array<{items: Array<{str: string}>}>} pages  text items per page, in
 *   the same order pdf.js creates text-layer spans (items without `str` removed).
 */
export function buildIndex(pages) {
  const keyParts = [];
  const rawStart = []; // key char -> global raw offset of its source code point
  const rawEnd = []; //   key char -> global raw end offset (exclusive)
  const itemPage = [];
  const itemIndex = [];
  const itemStart = []; // global raw offset of each item
  const pageKeyStart = [];
  let raw = 0;
  let keyLen = 0;

  pages.forEach((page, p) => {
    pageKeyStart.push(keyLen);
    page.items.forEach((item, i) => {
      itemPage.push(p);
      itemIndex.push(i);
      itemStart.push(raw);
      let off = 0;
      for (const cp of item.str) {
        const folded = foldCodePoint(cp);
        for (let k = 0; k < folded.length; k++) {
          rawStart.push(raw + off);
          rawEnd.push(raw + off + cp.length);
        }
        if (folded) keyParts.push(folded);
        keyLen += folded.length;
        off += cp.length;
      }
      raw += item.str.length;
    });
  });
  pageKeyStart.push(keyLen);

  const key = keyParts.join("");
  // Letters-only projection, for quotes that dropped citation numbers etc.
  const lettersMap = [];
  let letters = "";
  for (let i = 0; i < key.length; i++) {
    if (!/\p{N}/u.test(key[i])) {
      letters += key[i];
      lettersMap.push(i);
    }
  }

  return {
    pages,
    key,
    rawStart: Int32Array.from(rawStart),
    rawEnd: Int32Array.from(rawEnd),
    itemPage: Int32Array.from(itemPage),
    itemIndex: Int32Array.from(itemIndex),
    itemStart: Int32Array.from(itemStart),
    rawLength: raw,
    pageKeyStart,
    letters,
    lettersMap: Int32Array.from(lettersMap),
    gramIndex: new Map(), // k -> Map(gram -> positions), built lazily
  };
}

function pageOfKeyPos(index, pos) {
  const starts = index.pageKeyStart;
  let lo = 0;
  let hi = starts.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo; // 0-based
}

/** Distance (in pages) from a key position to the hinted page; 0 if no hint. */
function pageDistance(index, pos, hintPage) {
  if (!hintPage) return 0;
  return Math.abs(pageOfKeyPos(index, pos) + 1 - hintPage);
}

function allOccurrences(haystack, needle, limit = 50) {
  const found = [];
  let from = 0;
  while (found.length < limit) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    found.push(at);
    from = at + 1;
  }
  return found;
}

function closestToPage(index, positions, hintPage) {
  let best = positions[0];
  let bestDist = Infinity;
  for (const p of positions) {
    const d = pageDistance(index, p, hintPage);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best;
}

function gramsFor(index, k) {
  let grams = index.gramIndex.get(k);
  if (grams) return grams;
  grams = new Map();
  const key = index.key;
  for (let i = 0; i + k <= key.length; i++) {
    const g = key.substr(i, k);
    const list = grams.get(g);
    if (list) {
      if (list.length < 400) list.push(i);
    } else grams.set(g, [i]);
  }
  index.gramIndex.set(k, grams);
  return grams;
}

/**
 * Fitting alignment: align all of `q` against the best substring of
 * text[from, to). Unit costs for substitution/insertion/deletion.
 * Returns { cost, start, end } in text coordinates.
 */
function fitAlign(q, text, from, to) {
  const m = q.length;
  const n = to - from;
  let prev = new Int32Array(n + 1);
  let prevStart = new Int32Array(n + 1);
  let cur = new Int32Array(n + 1);
  let curStart = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) prevStart[j] = j; // free leading text
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    curStart[0] = 0;
    const qc = q.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      let best = prev[j - 1] + (qc === text.charCodeAt(from + j - 1) ? 0 : 1);
      let start = prevStart[j - 1];
      const del = prev[j] + 1;
      if (del < best) {
        best = del;
        start = prevStart[j];
      }
      const ins = cur[j - 1] + 1;
      if (ins < best) {
        best = ins;
        start = curStart[j - 1];
      }
      cur[j] = best;
      curStart[j] = start;
    }
    [prev, cur] = [cur, prev];
    [prevStart, curStart] = [curStart, prevStart];
  }
  let bestJ = 0;
  for (let j = 1; j <= n; j++) if (prev[j] < prev[bestJ]) bestJ = j;
  return { cost: prev[bestJ], start: from + prevStart[bestJ], end: from + bestJ };
}

function fuzzyFind(index, qKey, hintPage) {
  const key = index.key;
  const m = qKey.length;
  const candidates = [];

  const k = m >= 60 ? 8 : m >= 24 ? 6 : 4;
  if (m >= k) {
    const grams = gramsFor(index, k);
    const votes = new Map();
    const BUCKET = 16;
    for (let i = 0; i + k <= m; i++) {
      const list = grams.get(qKey.substr(i, k));
      if (!list || list.length > 200) continue;
      for (const p of list) {
        const b = Math.floor((p - i) / BUCKET);
        votes.set(b, (votes.get(b) || 0) + 1);
      }
    }
    const scored = [...votes.keys()].map((b) => ({
      b,
      v: (votes.get(b - 1) || 0) + votes.get(b) + (votes.get(b + 1) || 0),
    }));
    scored.sort((a, b) => b.v - a.v);
    const seen = new Set();
    for (const { b, v } of scored) {
      if (candidates.length >= 6) break;
      if (seen.has(b) || seen.has(b - 1) || seen.has(b + 1)) continue;
      // Require a minimum of evidence so we don't align against noise.
      if (v < Math.max(2, Math.floor((m - k + 1) * 0.08))) break;
      seen.add(b);
      candidates.push(b * BUCKET);
    }
  }

  // Short or heavily garbled quotes: fall back to scanning the hinted pages.
  if (candidates.length === 0 && hintPage && m <= 200) {
    const p0 = Math.max(0, hintPage - 2);
    const p1 = Math.min(index.pages.length, hintPage + 1);
    const from = index.pageKeyStart[p0];
    const to = index.pageKeyStart[p1];
    if (to > from) {
      const r = fitAlign(qKey, key, from, to);
      return { ...r, score: 1 - r.cost / m };
    }
  }

  let best = null;
  const slack = Math.max(24, Math.round(m * 0.3));
  for (const diag of candidates) {
    const from = Math.max(0, diag - slack);
    const to = Math.min(key.length, diag + m + slack);
    const r = fitAlign(qKey, key, from, to);
    const score = 1 - r.cost / m;
    const better =
      !best ||
      score > best.score + 1e-9 ||
      (Math.abs(score - best.score) < 1e-9 &&
        pageDistance(index, r.start, hintPage) < pageDistance(index, best.start, hintPage));
    if (better) best = { ...r, score };
  }
  return best;
}

/** Convert a key range [ks, ke) to per-item segments. */
export function keyRangeToSegments(index, ks, ke) {
  if (ke <= ks) return [];
  const rawFrom = index.rawStart[ks];
  const rawTo = index.rawEnd[ke - 1];
  const segments = [];
  // Binary search the first item containing rawFrom.
  const starts = index.itemStart;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= rawFrom) lo = mid;
    else hi = mid - 1;
  }
  for (let it = lo; it < starts.length && starts[it] < rawTo; it++) {
    const page = index.itemPage[it];
    const item = index.itemIndex[it];
    const str = index.pages[page].items[item].str;
    const s = Math.max(0, rawFrom - starts[it]);
    const e = Math.min(str.length, rawTo - starts[it]);
    if (e > s) segments.push({ page: page + 1, item, start: s, end: e });
  }
  // Keys hold no punctuation, so a match stops at the last letter; include
  // the closing punctuation right after it so "…test set." looks complete.
  const last = segments.at(-1);
  if (last) {
    const str = index.pages[last.page - 1].items[last.item].str;
    while (last.end < str.length && TRAILING.test(str[last.end])) last.end++;
  }
  return segments;
}

export const THRESHOLDS = { approximate: 0.9, low: 0.7 };

function matchFragment(index, text, hintPage) {
  const { key: qKey } = toKey(text);
  if (qKey.length < 4) return null;

  // Tier 1: exact match in key space.
  let hits = allOccurrences(index.key, qKey);
  if (hits.length) {
    const at = closestToPage(index, hits, hintPage);
    return { status: "exact", score: 1, ks: at, ke: at + qKey.length, len: qKey.length };
  }

  // Tier 2: ignore digits (dropped citation numbers, footnote marks, "Eq. (3)").
  const qLetters = qKey.replace(/\p{N}/gu, "");
  if (qLetters.length >= 12) {
    hits = allOccurrences(index.letters, qLetters);
    if (hits.length) {
      const atL = closestToPage(index, hits.map((h) => index.lettersMap[h]), hintPage);
      const li = hits.find((h) => index.lettersMap[h] === atL);
      const ks = index.lettersMap[li];
      const ke = index.lettersMap[li + qLetters.length - 1] + 1;
      return { status: "exact", score: 1, ks, ke, len: qKey.length, normalized: true };
    }
  }

  // Tier 3: fuzzy alignment.
  if (qKey.length < 8) return null;
  const best = fuzzyFind(index, qKey, hintPage);
  if (!best || best.score < THRESHOLDS.low) {
    return best ? { status: "none", score: best.score, len: qKey.length } : null;
  }
  return {
    status: best.score >= THRESHOLDS.approximate ? "approximate" : "low",
    score: best.score,
    ks: best.start,
    ke: best.end,
    len: qKey.length,
  };
}

const ELLIPSIS = /\s*(?:\[\s*(?:\.\s*){3}\]|\[\s*…\s*\]|(?:\.\s*){3}|…)\s*/u;

const RANK = { none: 0, low: 1, approximate: 2, exact: 3 };

/**
 * Locate a quote in the document.
 * @returns {{status: "exact"|"approximate"|"low"|"none", score: number,
 *            segments: Array<{page,item,start,end}>, page: number|null}}
 */
export function matchQuote(index, quote, hintPage) {
  // Try the quote as a whole first: "..." may be part of the source itself
  // (table-of-contents leaders, figure labels), not an elision.
  const whole = matchFragments(index, [quote], hintPage);
  if (whole.status === "exact") return whole;
  const fragments = quote.split(ELLIPSIS).map((s) => s.trim()).filter(Boolean);
  if (fragments.length < 2) return whole;
  const split = matchFragments(index, fragments, hintPage);
  const better =
    RANK[split.status] > RANK[whole.status] ||
    (RANK[split.status] === RANK[whole.status] && split.score > whole.score);
  return better ? split : whole;
}

function matchFragments(index, fragments, hintPage) {
  const results = [];
  let totalLen = 0;
  let weighted = 0;
  let lastPage = hintPage;
  for (const frag of fragments) {
    const r = matchFragment(index, frag, lastPage);
    if (!r) continue; // fragment too short to matter
    totalLen += r.len;
    weighted += r.score * r.len;
    if (r.status !== "none") {
      results.push(r);
      lastPage = pageOfKeyPos(index, r.ks) + 1;
    }
  }
  if (totalLen === 0 || results.length === 0) {
    return { status: "none", score: totalLen ? weighted / totalLen : 0, segments: [], page: null };
  }

  const score = weighted / totalLen;
  const matchedLen = results.reduce((a, r) => a + r.len, 0);
  let status;
  if (matchedLen < totalLen * 0.6) status = "low";
  else if (results.every((r) => r.status === "exact") && matchedLen === totalLen) status = "exact";
  else status = score >= THRESHOLDS.approximate ? "approximate" : "low";

  const segments = results.flatMap((r) => keyRangeToSegments(index, r.ks, r.ke));
  return { status, score, segments, page: pageOfKeyPos(index, results[0].ks) + 1 };
}

/**
 * Plain text for the model: one block per page, line breaks preserved,
 * line-end hyphenation joined, runs of spaces collapsed.
 */
export function pageText(page) {
  let text = "";
  for (const item of page.items) {
    text += item.str;
    if (item.hasEOL) text += "\n";
  }
  return text
    .replace(/[ \t ]+/g, " ")
    .replace(/(\p{Ll})[-­‐]\s*\n\s*(\p{Ll})/gu, "$1$2")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
