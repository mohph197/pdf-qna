// Semantic Scholar Academic Graph API client used by the service worker for
// citation previews and the paper info panel. No key is needed; an optional
// key (options page) gives the user their own rate limit instead of the
// shared one.

import { titleFits } from "../lib/references.js";

const API = "https://api.semanticscholar.org/graph/v1";
const FIELDS = [
  "title",
  "url",
  "authors",
  "venue",
  "publicationVenue",
  "journal",
  "year",
  "publicationDate",
  "citationCount",
  "influentialCitationCount",
  "referenceCount",
  "tldr",
  "abstract",
  "externalIds",
  "openAccessPdf",
  "citationStyles",
].join(",");

export class ScholarError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new ScholarError("aborted", "Cancelled."));
    });
  });

// GET with retries: the keyless API shares one rate limit among all users and
// answers 429 at busy times, often for just a moment.
async function get(path, { apiKey, signal }) {
  const delays = [1000, 2500];
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${API}${path}`, { headers: apiKey ? { "x-api-key": apiKey } : {}, signal });
    } catch (e) {
      if (signal?.aborted) throw new ScholarError("aborted", "Cancelled.");
      throw new ScholarError("network", `Couldn't reach Semantic Scholar (${e.message}).`);
    }
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    if (res.status === 403 && apiKey) {
      throw new ScholarError("auth", "Semantic Scholar rejected your API key. Check it on the options page, or remove it.");
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= delays.length) {
      throw res.status === 429
        ? new ScholarError(
            "rate_limit",
            "Semantic Scholar is busy right now. Try again in a moment, or add a free Semantic Scholar API key on the options page.",
          )
        : new ScholarError("server", `Semantic Scholar returned HTTP ${res.status}.`);
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(retryAfter > 0 && retryAfter <= 5 ? retryAfter * 1000 : delays[attempt], signal);
  }
}

const idPath = (id) => id.split("/").map(encodeURIComponent).join("/");

/**
 * Find a paper. `query` is { doi?, arxiv?, acl?, title?, context? }; ids are
 * tried first, then a title match, which is accepted only when the found
 * title fits `context` (the reference text) or the title itself.
 * Resolves to a normalized paper or null when nothing matches.
 */
export async function lookupPaper(query, { apiKey = "", signal } = {}) {
  const opts = { apiKey, signal };
  const ids = [
    query.doi && `DOI:${query.doi}`,
    query.arxiv && `ARXIV:${query.arxiv}`,
    query.acl && `ACL:${query.acl}`,
  ].filter(Boolean);
  for (const id of ids) {
    const paper = await get(`/paper/${idPath(id)}?fields=${FIELDS}`, opts);
    if (paper?.paperId) return normalize(paper);
  }
  if (!query.title) return null;
  const found = await get(`/paper/search/match?query=${encodeURIComponent(query.title.slice(0, 300))}&fields=${FIELDS}`, opts);
  const paper = found?.data?.[0];
  if (!paper || !titleFits(paper.title, query.context || query.title)) return null;
  return normalize(paper);
}

function normalize(p) {
  const ext = p.externalIds ?? {};
  return {
    id: p.paperId,
    title: p.title ?? "",
    url: p.url ?? `https://www.semanticscholar.org/paper/${p.paperId}`,
    authors: (p.authors ?? []).map((a) => a.name).filter(Boolean),
    venue: p.publicationVenue?.name || p.journal?.name || p.venue || "",
    venueShort: p.publicationVenue?.alternate_names?.find((n) => /^[A-Z][A-Za-z-]{1,9}$/.test(n)) ?? "",
    year: p.year ?? null,
    date: p.publicationDate ?? null,
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
