# Changelog

All notable changes to Paper Q&A are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-27

First public release.

- Opens PDFs (web or local) in a bundled pdf.js 6.4.299 viewer with a Q&A sidebar.
- Asks Claude (Opus 5.5 by default; Sonnet 5.5, Haiku 5.5 or Fable 5.1 are selectable) for short answers with 1–3 verbatim supporting quotes per question, as validated JSON. Malformed replies are retried once.
- Highlights quotes in the text layer, with one color per question. Clicking a quote scrolls to and flashes it.
- Robust quote matching across line breaks, hyphenation, ligatures, smart punctuation, page breaks, dropped citations, elisions and small wording changes. Approximate and low-confidence matches are labeled.
- Exports the PDF with highlights saved as standard PDF annotations.
- Caches answers per file (SHA-256), so reopening a paper restores them without an API call.
- Clear errors for a missing or invalid key, unknown models, rate limits, overload, refusals and papers too long for the model.
