// Prompts, response schemas and validators for the "Implement" tab: listing
// the systems a paper implements, then writing a Claude Code prompt that
// reimplements one of them.

import { normalizeUrl, paperBlock, parseJson } from "./prompt.js";

export const SYSTEMS_PROMPT = `You read a research paper and list what its authors implemented: each distinct model, architecture, system, algorithm or tool that the paper itself contributes and describes well enough for someone to reimplement it in code.

The user message contains the paper inside <paper> tags, split into pages marked "=== Page N ===".

Rules:
- List the paper's own contributions only. Baselines, prior work and off-the-shelf components it merely uses are not entries.
- Variants of one thing are one entry: sizes or depths of one model, ablations, or a model together with its training pipeline. Mention the variants in the summary.
- Separate entries are things a reader could reasonably want to build on their own, such as a model and a separate data-collection system, or two unrelated methods.
- Return an empty list when the paper implements nothing that can be built, such as a survey, a position paper or a purely theoretical paper.

For each entry, return:
- name: the name the paper uses, or a short descriptive name if it has none.
- kind: one or two words, such as "model", "architecture", "training method", "algorithm", "system", "benchmark" or "library".
- summary: one or two sentences saying what it is and what it does.
- pages: the page numbers (from the "=== Page N ===" markers) where it is mainly described.

Order the entries by how central they are to the paper, the main contribution first.`;

export const SYSTEMS_SCHEMA = {
  type: "object",
  properties: {
    systems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          kind: { type: "string" },
          summary: { type: "string" },
          pages: { type: "array", items: { type: "integer" } },
        },
        required: ["name", "kind", "summary", "pages"],
        additionalProperties: false,
      },
    },
  },
  required: ["systems"],
  additionalProperties: false,
};

export const IMPLEMENT_PROMPT = `You write a prompt that a reader will paste into Claude Code, an AI coding agent working in an empty repository, so that it reimplements exactly what a research paper built.

The user message contains the paper inside <paper> tags, split into pages marked "=== Page N ===", then the system to implement inside <target> tags. It may also list the paper's other systems (not to be implemented, except as parts the target needs) and the reader's notes, such as a preferred framework or compute budget; follow those notes.

The coding agent will not see the paper. Everything it needs must be in your prompt, which must be faithful to the paper: the goal is to build what the authors built, not an improved or simplified version, unless the reader's notes ask for one.

Write the prompt in Markdown, addressed to the coding agent, with these parts:
1. Goal: the paper (title, authors, year, and its arXiv or DOI link if you know it) and what to build, in a short paragraph.
2. Specification: everything the paper states about the target, with the page it comes from, for example "(p. 4)". Cover whichever of these apply: inputs and outputs; the architecture or system design, component by component, with every dimension, layer count, activation, normalization and initialization; the algorithm step by step; every equation, transcribed exactly in LaTeX or code notation with its symbols defined; losses and objectives; training procedure (optimizer and its settings, learning rate schedule, batch size, steps or epochs, regularization, hardware); data (datasets, where to get them, preprocessing, augmentation, splits); inference or decoding; evaluation metrics and protocol. Use tables for hyperparameters. Read the appendix and figure and table captions; details are often only there.
3. Gaps and assumptions: every detail the implementation needs that the paper does not state, each with a recommended choice and why (a common default for the time, a cited work's setting, or the official code). Mark them clearly so the agent never mistakes an assumption for the paper's specification. Never fill a gap silently, and never invent a number and present it as the paper's.
4. Expected results: the numbers the paper reports for the target (with table or figure and page), as targets for a faithful reproduction, and what smaller-scale result would show the implementation is on track.
5. Plan: the tech stack (the one the paper used if stated, otherwise a sensible current default), the repository layout, and ordered milestones. Each milestone ends with a check the agent runs, such as unit tests of tensor shapes and of each equation on tiny inputs, overfitting a small batch, or matching a number from the paper at small scale.
6. Working rules for the agent: implement the specification as written; when the paper is ambiguous, follow the recommendation in "Gaps and assumptions" and leave a comment citing it; keep hyperparameters in one config file with the paper's values as defaults; ask the user before downloading very large datasets or starting long or expensive training runs; finish with a short report of what was built, what was verified, and which assumptions were made.

Be complete rather than brief: a long, precise prompt is better than a short one that leaves the agent guessing. Do not add content that does not help the agent implement the target.

Web search: if the target line says [web search allowed], use web_search and web_fetch to look for the official code, a project page, the appendix or supplementary material if the paper text lacks it, and errata, and fetch the pages that matter (for example the official repository's README and configuration files). Use them to resolve gaps, and say in the prompt which details come from which URL. When the paper and the official code disagree, follow the paper, and note the difference and the code's value. Give the official repository's URL to the agent as a reference to check against, not as code to copy. List every page you relied on in web_sources with its exact url and title. Without [web search allowed], use only the paper and return an empty web_sources list.

Return the prompt in "prompt" and nothing else outside the JSON object.`;

export const IMPLEMENT_SCHEMA = {
  type: "object",
  properties: {
    prompt: { type: "string" },
    web_sources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          url: { type: "string" },
          title: { type: "string" },
        },
        required: ["url", "title"],
        additionalProperties: false,
      },
    },
  },
  required: ["prompt", "web_sources"],
  additionalProperties: false,
};

export function buildSystemsContent(pageTexts) {
  return [paperBlock(pageTexts), { type: "text", text: "List the systems this paper implements." }];
}

const systemLine = (s) => `${s.name}${s.kind ? ` (${s.kind})` : ""}: ${s.summary}`;

/**
 * @param {string[]} pageTexts
 * @param {object} p
 * @param {{ name, kind, summary, pages }} p.system  the system to implement
 * @param {{ name, kind, summary }[]} [p.others]  the paper's other systems
 * @param {string} [p.notes]  the reader's constraints
 * @param {boolean} [p.web]  may search and fetch web pages
 */
export function buildImplementContent(pageTexts, { system, others = [], notes = "", web = false }) {
  const parts = [`<target>${web ? "[web search allowed] " : ""}${systemLine(system)}${system.pages?.length ? ` (described on pp. ${system.pages.join(", ")})` : ""}</target>`];
  if (others.length) parts.push(`The paper's other systems:\n${others.map((s) => `- ${systemLine(s)}`).join("\n")}`);
  if (notes.trim()) parts.push(`<notes>\n${notes.trim()}\n</notes>`);
  parts.push("Write the Claude Code prompt for the target.");
  return [paperBlock(pageTexts), { type: "text", text: parts.join("\n\n") }];
}

/** Validate the systems list. Throws an Error describing the first problem. */
export function parseSystems(text, pageCount) {
  const data = parseJson(text);
  if (!data || !Array.isArray(data.systems)) throw new Error('Missing "systems" array.');
  return data.systems.map((s, i) => {
    if (!s || typeof s.name !== "string" || !s.name.trim()) throw new Error(`System ${i + 1} has no name.`);
    if (typeof s.summary !== "string") throw new Error(`System ${i + 1}: "summary" must be a string.`);
    const pages = Array.isArray(s.pages) ? s.pages.filter((p) => Number.isInteger(p) && p >= 1 && p <= pageCount) : [];
    return {
      name: s.name.trim(),
      kind: typeof s.kind === "string" ? s.kind.trim() : "",
      summary: s.summary.trim(),
      pages: [...new Set(pages)].sort((a, b) => a - b),
    };
  });
}

/**
 * Validate the implementation prompt. Web sources are kept only when a search
 * or fetch actually returned their url (searchResults: url -> title).
 */
export function parseImplementation(text, { web = false, searchResults = new Map() } = {}) {
  const data = parseJson(text);
  if (!data || typeof data.prompt !== "string" || !data.prompt.trim()) throw new Error('Missing "prompt" text.');
  if (data.web_sources != null && !Array.isArray(data.web_sources)) throw new Error('"web_sources" must be an array.');
  const seen = new Map([...searchResults].map(([url, title]) => [normalizeUrl(url), { url, title }]));
  const webSources = [];
  for (const w of web ? (data.web_sources ?? []) : []) {
    if (!w || typeof w.url !== "string") continue;
    const hit = seen.get(normalizeUrl(w.url));
    if (!hit || webSources.some((s) => s.url === hit.url)) continue;
    webSources.push({ url: hit.url, title: hit.title || (typeof w.title === "string" ? w.title.trim() : "") || hit.url });
  }
  return { prompt: data.prompt.trim(), webSources };
}
