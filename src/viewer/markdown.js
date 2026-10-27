// Renders the questions, answers and supporting quotes of a paper as a
// Markdown document. Pure function, so it can also run in Node.

const STATUS_NOTE = {
  approximate: (m) => ` _(close match, ${Math.round(m.score * 100)}%)_`,
  low: (m) => ` _(low-confidence match, ${Math.round(m.score * 100)}%)_`,
  none: () => " _(not found in the PDF text)_",
};

/** Quote text as a Markdown blockquote; every line needs its own marker. */
function blockquote(text) {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

/**
 * @param {object} p
 * @param {string} p.name  file name of the PDF
 * @param {{ id, text }[]} p.questions
 * @param {object} p.results  id -> { answerable, answer, quotes: [{ text, page }], model }
 * @param {object} p.matches  id -> [{ status, score, page, segments }] per quote
 * @param {Date} [p.date]
 */
export function answersToMarkdown({ name, questions, results, matches, date = new Date() }) {
  const models = [...new Set(questions.map((q) => results[q.id]?.model).filter(Boolean))];
  const out = [`# ${name}`, ""];
  out.push(
    `Questions and answers exported from Paper Q&A on ${date.toISOString().slice(0, 10)}` +
      (models.length ? ` · answered by ${models.join(", ")}` : "") +
      ".",
  );

  questions.forEach((q, n) => {
    out.push("", `## ${n + 1}. ${q.text}`, "");
    const res = results[q.id];
    if (!res) {
      out.push("_Not asked yet._");
      return;
    }
    out.push(res.answerable ? res.answer : `**Not answered in the paper.** ${res.answer}`);
    res.quotes.forEach((quote, qi) => {
      const m = matches[q.id]?.[qi];
      const found = m && m.segments.length > 0;
      const page = found ? m.page : quote.page;
      const note = m ? (STATUS_NOTE[found ? m.status : "none"]?.(m) ?? "") : "";
      out.push("", blockquote(`“${quote.text}”`), ">", `> — ${page ? `p. ${page}` : "page unknown"}${note}`);
    });
  });
  return out.join("\n") + "\n";
}
