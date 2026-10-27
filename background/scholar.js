// Paper lookups for citation previews and the paper info panel, used by the
// service worker. Two routes run at once and the first verified match wins:
//
// - Semantic Scholar (richest: TL;DR, influential citations). Its keyless
//   API shares one rate limit among all users and often answers 429, so
//   without a key it gets a single attempt and never holds things up.
// - Crossref, which matches raw reference strings well, to find the DOI,
//   and arXiv's title search for preprints and papers without one (such as
//   ICLR papers). Then OpenAlex by DOI (free and keyless for single records)
//   for citation counts, venue, abstract and open-access PDF; arXiv papers
//   have arXiv DOIs (10.48550/arXiv.<id>).
//
// Found papers are cached in chrome.storage.local for a week.

import { titleFits } from "../lib/references.js";

const S2 = "https://api.semanticscholar.org/graph/v1";
const CROSSREF = "https://api.crossref.org/works";
const OPENALEX = "https://api.openalex.org/works";
const ARXIV = "https://export.arxiv.org/api/query";
const TIMEOUT = 8000;
const CACHE_DAYS = 7;

const S2_FIELDS = [
  "title",
  "url",
  "authors",
  "venue",
  "publicationVenue",
  "journal",
  "year",
  "citationCount",
  "influentialCitationCount",
  "referenceCount",
  "tldr",
  "abstract",
  "externalIds",
  "openAccessPdf",
  "citationStyles",
].join(",");
const CROSSREF_FIELDS = "DOI,title,author,container-title,issued,is-referenced-by-count,type,abstract";
const OPENALEX_FIELDS = [
  "id",
  "doi",
  "display_name",
  "publication_year",
  "type",
  "cited_by_count",
  "referenced_works_count",
  "authorships",
  "primary_location",
  "best_oa_location",
  "locations",
  "abstract_inverted_index",
  "biblio",
].join(",");

export class ScholarError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Find a paper. `query` is { doi?, arxiv?, acl?, title?, context? }, where
 * `context` is the text a found title must fit (the reference entry, or the
 * title guess). Resolves to a normalized paper, or null when no source finds
 * it; rejects only when every source failed.
 */
export async function lookupPaper(query, { apiKey = "", signal, storage = chrome.storage.local } = {}) {
  const key = `paper:${JSON.stringify(query)}`;
  const hit = (await storage.get(key).catch(() => ({})))[key];
  if (hit && Date.now() - hit.at < CACHE_DAYS * 864e5) return hit.paper;
  const paper = await firstPaper([
    semanticScholar(query, { apiKey, signal }),
    crossrefAndOpenAlex(query, { signal }),
  ]);
  if (paper) storage.set({ [key]: { at: Date.now(), paper } }).catch(() => {});
  return paper;
}

// The first source to find the paper wins. If none does, "not found" beats
// an error from a source that was merely busy.
function firstPaper(sources) {
  return new Promise((resolve, reject) => {
    let pending = sources.length;
    let notFound = false;
    const errors = [];
    const settle = () => {
      if (--pending) return;
      if (notFound || !errors.length) resolve(null);
      else reject(errors.find((e) => e.code !== "rate_limit") ?? errors[0]);
    };
    for (const source of sources) {
      source.then(
        (paper) => {
          if (paper) resolve(paper);
          else notFound = true;
          settle();
        },
        (err) => {
          errors.push(err instanceof ScholarError ? err : new ScholarError("error", err?.message ?? String(err)));
          settle();
        },
      );
    }
  });
}

async function getJson(url, { signal, headers = {}, name }) {
  let res;
  try {
    const timeout = AbortSignal.timeout(TIMEOUT);
    res = await fetch(url, { headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (e) {
    if (signal?.aborted) throw new ScholarError("aborted", "Cancelled.");
    if (e?.name === "TimeoutError") throw new ScholarError("timeout", `${name} didn't answer in time.`);
    throw new ScholarError("network", `Couldn't reach ${name} (${e.message}).`);
  }
  if (res.ok) return res.json();
  if (res.status === 404) return null;
  if (res.status === 429) throw new ScholarError("rate_limit", `${name} is busy right now.`);
  if (res.status === 403 && headers["x-api-key"]) {
    throw new ScholarError("auth", "Semantic Scholar rejected your API key. Check it on the options page, or remove it.");
  }
  throw new ScholarError("server", `${name} returned HTTP ${res.status}.`);
}

const idPath = (id) => id.split("/").map(encodeURIComponent).join("/");

// ---------------------------------------------------------------------------
// Semantic Scholar

async function semanticScholar(query, { apiKey, signal }) {
  const opts = { signal, name: "Semantic Scholar", headers: apiKey ? { "x-api-key": apiKey } : {} };
  // With a key the limit is the user's own, so a 429 is brief: retry once.
  const get = async (path) => {
    try {
      return await getJson(`${S2}${path}`, opts);
    } catch (e) {
      if (!apiKey || e.code !== "rate_limit") throw e;
      await new Promise((r) => setTimeout(r, 1100));
      return getJson(`${S2}${path}`, opts);
    }
  };
  const ids = [
    query.doi && `DOI:${query.doi}`,
    query.arxiv && `ARXIV:${query.arxiv}`,
    query.acl && `ACL:${query.acl}`,
  ].filter(Boolean);
  for (const id of ids) {
    const paper = await get(`/paper/${idPath(id)}?fields=${S2_FIELDS}`);
    if (paper?.paperId) return fromSemanticScholar(paper);
  }
  if (!query.title) return null;
  const found = await get(`/paper/search/match?query=${encodeURIComponent(query.title.slice(0, 300))}&fields=${S2_FIELDS}`);
  const paper = found?.data?.[0];
  return paper && titleFits(paper.title, query.context || query.title) ? fromSemanticScholar(paper) : null;
}

function fromSemanticScholar(p) {
  const ext = p.externalIds ?? {};
  const url = p.url ?? `https://www.semanticscholar.org/paper/${p.paperId}`;
  return {
    source: "Semantic Scholar",
    title: p.title ?? "",
    url,
    citationsUrl: `${url}#citing-papers`,
    authors: (p.authors ?? []).map((a) => a.name).filter(Boolean),
    venue: p.publicationVenue?.name || p.journal?.name || p.venue || "",
    venueShort: p.publicationVenue?.alternate_names?.find((n) => /^[A-Z][A-Za-z-]{1,9}$/.test(n)) ?? "",
    year: p.year ?? null,
    citations: p.citationCount ?? null,
    influential: p.influentialCitationCount ?? null,
    references: p.referenceCount ?? null,
    tldr: p.tldr?.text ?? "",
    abstract: p.abstract ?? "",
    doi: ext.DOI ?? null,
    arxiv: ext.ArXiv ?? null,
    pdf: p.openAccessPdf?.url || null,
    bibtex: p.citationStyles?.bibtex ?? "",
  };
}

// ---------------------------------------------------------------------------
// Crossref + OpenAlex

const arxivDoi = (id) => `10.48550/arxiv.${id}`.toLowerCase();
// ACL Anthology papers from 2016 on have DOIs 10.18653/v1/<id>.
const aclDoi = (id) => (/^[A-Z]\d{2}-\d{4}$|^\d{4}\./.test(id) ? `10.18653/v1/${id}`.toLowerCase() : null);

async function crossrefAndOpenAlex(query, { signal }) {
  const context = query.context || query.title || "";
  const known = [query.doi?.toLowerCase(), query.arxiv && arxivDoi(query.arxiv), query.acl && aclDoi(query.acl)].filter(Boolean);
  const [byId, byText, byArxiv] = await Promise.allSettled([
    Promise.all(known.map((doi) => openAlexByDoi(doi, signal).catch(() => null))),
    context ? crossrefSearch(context, { signal }) : Promise.resolve(null),
    query.title && !query.arxiv ? arxivSearch(query.title, context, { signal }) : Promise.resolve(null),
  ]);
  const works = (byId.value ?? []).filter(Boolean);
  let crossref = byText.value ?? null;
  // An arXiv preprint's own record misses the citations of its published
  // version; look for that by title.
  if (!crossref && works.length && !query.doi) {
    crossref = await crossrefSearch(works[0].display_name ?? "", { signal, exact: true }).catch(() => null);
  }
  const arxiv = query.arxiv ?? byArxiv.value ?? null;
  const more = [
    crossref && !works.some((w) => sameDoi(w.doi, crossref.DOI)) ? crossref.DOI : null,
    byArxiv.value ? arxivDoi(byArxiv.value) : null,
  ].filter(Boolean);
  for (const work of await Promise.all(more.map((doi) => openAlexByDoi(doi, signal).catch(() => null)))) {
    if (work) works.push(work);
  }
  if (works.length) {
    // Several records of one paper (preprint, published): keep the most cited.
    const best = works.reduce((a, b) => ((b.cited_by_count ?? 0) > (a.cited_by_count ?? 0) ? b : a));
    return fromOpenAlex(best, arxiv ?? arxivFromWorks(works));
  }
  if (crossref) return fromCrossref(crossref, arxiv);
  // Nothing found, but report a failure rather than "not found" if a search failed.
  if (byText.status === "rejected") throw byText.reason;
  if (byArxiv.status === "rejected") throw byArxiv.reason;
  return null;
}

// arXiv's API answers in Atom; service workers have no DOMParser, and two
// fields are all that's needed.
async function arxivSearch(title, context, { signal }) {
  const phrase = title.replace(/["()]/g, " ").replace(/\s+/g, " ").trim();
  const url = `${ARXIV}?search_query=${encodeURIComponent(`ti:"${phrase}"`)}&max_results=3`;
  let res;
  try {
    const timeout = AbortSignal.timeout(TIMEOUT);
    res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (e) {
    throw new ScholarError(e?.name === "TimeoutError" ? "timeout" : "network", `Couldn't reach arXiv (${e.message}).`);
  }
  if (!res.ok) throw new ScholarError(res.status === 429 ? "rate_limit" : "server", `arXiv returned HTTP ${res.status}.`);
  for (const entry of (await res.text()).split("<entry>").slice(1)) {
    const id = entry.match(/<id>\s*https?:\/\/arxiv\.org\/abs\/(.+?)(?:v\d+)?\s*<\/id>/)?.[1];
    const found = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1].replace(/\s+/g, " ").trim();
    if (id && found && titleFits(found, context)) return id;
  }
  return null;
}

const sameDoi = (url, doi) => !!url && !!doi && url.toLowerCase().endsWith(`/${doi.toLowerCase()}`);

async function crossrefSearch(text, { signal, exact = false }) {
  if (!text.trim()) return null;
  const url = `${CROSSREF}?query.bibliographic=${encodeURIComponent(text.slice(0, 500))}&rows=3&select=${CROSSREF_FIELDS}`;
  const items = (await getJson(url, { signal, name: "Crossref" }))?.message?.items ?? [];
  // A found title must fit the reference; for an exact title search, it must
  // also not be much longer than the title searched for.
  return (
    items.find((it) => {
      const title = it.title?.[0];
      if (!title || !titleFits(title, text)) return false;
      return !exact || (titleFits(text, title) && it.type !== "posted-content");
    }) ?? null
  );
}

function openAlexByDoi(doi, signal) {
  return getJson(`${OPENALEX}/doi:${idPath(doi)}?select=${OPENALEX_FIELDS}`, { signal, name: "OpenAlex" });
}

function arxivFromWorks(works) {
  for (const w of works) {
    for (const loc of w.locations ?? []) {
      const m = loc.landing_page_url?.match(/arxiv\.org\/abs\/(.+?)(?:v\d+)?$/);
      if (m) return m[1];
    }
  }
  return null;
}

function abstractFromIndex(index) {
  if (!index) return "";
  const words = [];
  for (const [word, positions] of Object.entries(index)) for (const p of positions) words[p] = word;
  return words.filter(Boolean).join(" ");
}

function fromOpenAlex(w, arxiv) {
  const id = w.id?.replace("https://openalex.org/", "") ?? "";
  const source = w.primary_location?.source;
  // Some venue names repeat themselves: "IEEE Conf. on CVPR/Proceedings - IEEE Conf. on CVPR".
  const name = (source?.display_name ?? "").split("/")[0].trim();
  const venue = /arxiv/i.test(name) ? "" : name;
  const paper = {
    source: "OpenAlex",
    title: w.display_name ?? "",
    url: w.id ?? "",
    citationsUrl: id ? `https://openalex.org/works?filter=cites:${id}` : null,
    authors: (w.authorships ?? []).map((a) => a.author?.display_name).filter(Boolean),
    venue,
    venueShort: "",
    year: w.publication_year ?? null,
    citations: w.cited_by_count ?? null,
    influential: null,
    references: w.referenced_works_count || null,
    tldr: "",
    abstract: abstractFromIndex(w.abstract_inverted_index),
    doi: w.doi?.replace(/^https?:\/\/doi\.org\//, "") || null,
    arxiv: arxiv ?? null,
    pdf: w.best_oa_location?.pdf_url || null,
  };
  // OpenAlex calls conference papers "article"; the venue's type tells.
  paper.bibtex = bibtex(paper, { conference: "proceedings", journal: "article" }[source?.type] ?? w.type);
  return paper;
}

function fromCrossref(it, arxiv) {
  const paper = {
    source: "Crossref",
    title: it.title?.[0] ?? "",
    url: `https://doi.org/${it.DOI}`,
    citationsUrl: null,
    authors: (it.author ?? []).map((a) => [a.given, a.family].filter(Boolean).join(" ") || a.name).filter(Boolean),
    venue: it["container-title"]?.[0] ?? "",
    venueShort: "",
    year: it.issued?.["date-parts"]?.[0]?.[0] ?? null,
    citations: it["is-referenced-by-count"] ?? null,
    influential: null,
    references: null,
    tldr: "",
    abstract: (it.abstract ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/^\s*Abstract\s*/i, "").trim(),
    doi: it.DOI,
    arxiv: arxiv ?? null,
    pdf: null,
  };
  paper.bibtex = bibtex(paper, it.type);
  return paper;
}

/** A BibTeX entry from a normalized paper (Semantic Scholar supplies its own). */
export function bibtex(p, type = "") {
  const first = (p.authors[0] ?? "anon").split(/\s+/).at(-1).normalize("NFKD").replace(/[^A-Za-z]/g, "").toLowerCase();
  const word = (p.title.match(/[A-Za-z]{4,}/)?.[0] ?? "paper").toLowerCase();
  const kind = /proceedings|conference/.test(type) ? "inproceedings" : /article/.test(type) && p.venue ? "article" : "misc";
  const fields = [
    ["title", `{${p.title}}`],
    ["author", p.authors.join(" and ")],
    [kind === "inproceedings" ? "booktitle" : "journal", kind === "misc" ? "" : p.venue],
    ["year", p.year ?? ""],
    ["doi", p.doi ?? ""],
    ["eprint", p.arxiv ?? ""],
    ["archivePrefix", p.arxiv ? "arXiv" : ""],
  ].filter(([, v]) => v !== "" && v != null);
  return `@${kind}{${first}${p.year ?? ""}${word},\n${fields.map(([k, v]) => `  ${k} = {${v}}`).join(",\n")}\n}`;
}
