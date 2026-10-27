// System prompt, response schema and validator for the Q&A request.

export const SYSTEM_PROMPT = `You answer questions about a research paper using only the paper's text.

The user message contains the paper inside <paper> tags, split into pages marked "=== Page N ===", followed by numbered questions.

For every question, return:
- question_index: the question's number.
- answerable: true only if the paper itself answers the question. If it does not, set false, explain briefly in "answer" what the paper does or does not say, and return an empty quotes list. Never guess or fill gaps from outside knowledge.
- answer: a short, direct answer (one to three sentences).
- quotes: 1 to 3 passages that support the answer. Each quote must be copied VERBATIM from the paper text: the same words in the same order, without paraphrasing, fixing typos, or adding words. Copy one contiguous passage per quote, normally a single sentence or clause of roughly 10-50 words. Prefer the main body over the abstract when both say the same thing. Do not use "..." to stitch separate passages together; use separate quotes instead. Avoid quoting equations, tables or figure contents; quote the sentence that states the result instead.
- page: the page number (from the "=== Page N ===" marker) where the quote starts.

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
        },
        required: ["question_index", "answerable", "answer", "quotes"],
        additionalProperties: false,
      },
    },
  },
  required: ["answers"],
  additionalProperties: false,
};

export function buildUserContent(pageTexts, questions) {
  const paper = pageTexts.map((t, i) => `=== Page ${i + 1} ===\n${t}`).join("\n\n");
  const qs = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  return [
    // The paper is a stable prefix; caching it makes follow-up questions on
    // the same paper much cheaper.
    { type: "text", text: `<paper>\n${paper}\n</paper>`, cache_control: { type: "ephemeral" } },
    { type: "text", text: `Questions:\n${qs}` },
  ];
}

/**
 * Parse and validate the model's reply. Throws an Error describing the first
 * problem found; returns answers indexed by question position otherwise.
 */
export function parseAnswers(text, questionCount, pageCount) {
  let body = text.trim();
  const fenced = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced) body = fenced[1];
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    throw new Error(`Response is not valid JSON (${e.message}).`);
  }
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
    if (a.answerable && quotes.length === 0) throw new Error(`Answer ${idx} is marked answerable but has no quotes.`);
    out[idx - 1] = { answerable: a.answerable, answer: a.answer.trim(), quotes: quotes.slice(0, 3) };
  }
  const missing = out.findIndex((a) => a === null);
  if (missing >= 0) throw new Error(`No answer for question ${missing + 1}.`);
  return out;
}
