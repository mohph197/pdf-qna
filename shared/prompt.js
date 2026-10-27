// System prompt, response schema and validator for the Q&A request.

export const SYSTEM_PROMPT = `You answer questions about a research paper using only the paper's text.

The user message contains the paper inside <paper> tags, split into pages marked "=== Page N ===", followed by numbered questions.

For every question, return:
- question_index: the question's number.
- answerable: true only if the paper itself answers the question. If it does not, set false, explain briefly in "answer" what the paper does or does not say, and return an empty quotes list. Never guess or fill gaps from outside knowledge.
- answer: a short, direct answer (one to three sentences), unless the question is marked [free-form].
- quotes: 1 to 3 passages that support the answer. Each quote must be copied VERBATIM from the paper text: the same words in the same order, without paraphrasing, fixing typos, or adding words. Copy one contiguous passage per quote, normally a single sentence or clause of roughly 10-50 words. Prefer the main body over the abstract when both say the same thing. Do not use "..." to stitch separate passages together; use separate quotes instead. Avoid quoting equations, tables or figure contents; quote the sentence that states the result instead.
- page: the page number (from the "=== Page N ===" marker) where the quote starts.
- web_sources: an empty list, unless the question is marked [web search allowed].

Web search: only questions marked [web search allowed] may use the web_search tool. Search when the paper doesn't fully answer such a question or when the question asks about something outside the paper (later work, citations, code, authors, current status). For these questions, "answerable" is true if the paper or the web answers it, and the answer must say which parts come from the web. List each web page you relied on in web_sources with its exact url and title from the search results and a quote: a short passage copied verbatim from that page that supports the answer. Still quote the paper when it supports part of the answer. Never use web search for unmarked questions.

Free-form: for questions marked [free-form], "answer" takes whatever form and length the question asks for, such as a list, a Markdown table, JSON, or a full summary; follow any requested format exactly and use line breaks as needed. Quotes are optional for these questions: include up to 3 verbatim quotes only where they directly support the answer, and return an empty list otherwise. "answerable" is still false if the paper does not contain the requested information.

Answer every question exactly once, in order.`;

export const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question_index: { type: "integer" },
          answerable: { type: "boolean" },
          answer: { type: "string" },
          quotes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                page: { type: "integer" },
              },
              required: ["text", "page"],
              additionalProperties: false,
            },
          },
          web_sources: {
            type: "array",
            items: {
              type: "object",
              properties: {
                url: { type: "string" },
                title: { type: "string" },
                quote: { type: "string" },
              },
              required: ["url", "title", "quote"],
              additionalProperties: false,
            },
          },
        },
        required: ["question_index", "answerable", "answer", "quotes", "web_sources"],
        additionalProperties: false,
      },
    },
  },
  required: ["answers"],
  additionalProperties: false,
};

/** Questions are { text, web, freeform } objects; plain strings mean neither. */
const asQuestion = (q) => (typeof q === "string" ? { text: q } : q);

export function buildUserContent(pageTexts, questions) {
  const paper = pageTexts.map((t, i) => `=== Page ${i + 1} ===\n${t}`).join("\n\n");
  const qs = questions
    .map(asQuestion)
    .map((q, i) => `${i + 1}. ${q.web ? "[web search allowed] " : ""}${q.freeform ? "[free-form] " : ""}${q.text}`)
    .join("\n");
  return [
    // The paper is a stable prefix; caching it makes follow-up questions on
    // the same paper much cheaper.
    { type: "text", text: `<paper>\n${paper}\n</paper>`, cache_control: { type: "ephemeral" } },
    { type: "text", text: `Questions:\n${qs}` },
  ];
}

function parseJson(text) {
  let body = text.trim();
  const fenced = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced) body = fenced[1];
  try {
    return JSON.parse(body);
  } catch (e) {
    // Without a schema the model may wrap the object in prose.
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1));
      } catch {
        /* report the original error */
      }
    }
    throw new Error(`Response is not valid JSON (${e.message}).`);
  }
}

const normalizeUrl = (url) => url.trim().replace(/#.*$/, "").replace(/\/+$/, "");

/**
 * Parse and validate the model's reply. Throws an Error describing the first
 * problem found; returns answers indexed by question position otherwise.
 * @param {object} [opts]
 * @param {boolean[]} [opts.webAllowed]  per question: may it cite web pages?
 * @param {boolean[]} [opts.freeform]  per question: are quotes optional?
 * @param {Map<string, string>} [opts.searchResults]  url -> title of every web
 *   search result seen; web sources whose url isn't among them are dropped.
 */
export function parseAnswers(
  text,
  questionCount,
  pageCount,
  { webAllowed = [], freeform = [], searchResults = new Map() } = {},
) {
  const data = parseJson(text);
  const seen = new Map([...searchResults].map(([url, title]) => [normalizeUrl(url), { url, title }]));
  if (!data || !Array.isArray(data.answers)) throw new Error('Missing "answers" array.');

  const out = new Array(questionCount).fill(null);
  for (const a of data.answers) {
    if (!a || typeof a !== "object") throw new Error("An answer entry is not an object.");
    const idx = a.question_index;
    if (!Number.isInteger(idx) || idx < 1 || idx > questionCount) {
      throw new Error(`question_index ${JSON.stringify(idx)} is out of range 1-${questionCount}.`);
    }
    if (typeof a.answerable !== "boolean") throw new Error(`Answer ${idx}: "answerable" must be a boolean.`);
    if (typeof a.answer !== "string") throw new Error(`Answer ${idx}: "answer" must be a string.`);
    if (!Array.isArray(a.quotes)) throw new Error(`Answer ${idx}: "quotes" must be an array.`);
    const quotes = [];
    for (const q of a.quotes) {
      if (!q || typeof q.text !== "string" || !q.text.trim()) throw new Error(`Answer ${idx}: a quote has no text.`);
      const page = Number.isInteger(q.page) && q.page >= 1 && q.page <= pageCount ? q.page : null;
      quotes.push({ text: q.text.trim(), page });
    }
    const webSources = [];
    if (a.web_sources != null && !Array.isArray(a.web_sources)) throw new Error(`Answer ${idx}: "web_sources" must be an array.`);
    for (const w of a.web_sources ?? []) {
      if (!webAllowed[idx - 1]) break;
      if (!w || typeof w.url !== "string") throw new Error(`Answer ${idx}: a web source has no url.`);
      // Only keep pages a search actually returned, with the title it gave.
      const hit = seen.get(normalizeUrl(w.url));
      if (!hit || webSources.some((s) => s.url === hit.url)) continue;
      const quote = typeof w.quote === "string" ? w.quote.trim() : "";
      webSources.push({ url: hit.url, title: hit.title || (typeof w.title === "string" ? w.title.trim() : "") || hit.url, quote });
    }
    if (a.answerable && quotes.length === 0 && webSources.length === 0 && !freeform[idx - 1]) {
      throw new Error(`Answer ${idx} is marked answerable but has no quotes.`);
    }
    out[idx - 1] = { answerable: a.answerable, answer: a.answer.trim(), quotes: quotes.slice(0, 3), webSources };
  }
  const missing = out.findIndex((a) => a === null);
  if (missing >= 0) throw new Error(`No answer for question ${missing + 1}.`);
  return out;
}
