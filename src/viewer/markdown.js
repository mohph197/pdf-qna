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

// encodeURIComponent leaves parentheses alone, but they end a Markdown link.
const percentEncode = (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;

/**
 * @param {object} p
 * @param {string} p.name  file name of the PDF
 * @param {{ id, text, selection?: { text, page } }[]} p.questions
 * @param {object} p.results  id -> { answerable, answer, quotes: [{ text, page }], webSources: [{ url, title, quote }], model }
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
    // Multi-line (free-form) requests: first line as the heading, the rest verbatim.
    const [title, ...rest] = q.text.split(/\r?\n/);
    out.push("", `## ${n + 1}. ${title}`, "");
    if (rest.some((l) => l.trim())) out.push("```text", ...rest, "```", "");
    if (q.selection) {
      const { text, page } = q.selection;
      out.push(`About the selected text${page ? ` on p. ${page}` : ""}:`, "", blockquote(`“${text}”`), "");
    }
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
    if (res.webSources?.length) {
      out.push("", "Web sources:", "");
      for (const src of res.webSources) {
        out.push(`- [${src.title.replace(/[[\]]/g, "\\$&")}](${src.url.replace(/[()\s]/g, percentEncode)})`);
        if (src.quote) out.push(`  > “${src.quote.replace(/\s*\n\s*/g, " ")}”`);
      }
    }
  });
  return out.join("\n") + "\n";
}
