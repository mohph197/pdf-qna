# Changelog

All notable changes to Paper Q&A are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## [1.4.0](https://github.com/mohph197/pdf-qna/compare/v1.3.1...v1.4.0) (2026-10-29)


### Features

* **sidebar:** Implement tab that writes a Claude Code prompt to reimplement the paper ([#18](https://github.com/mohph197/pdf-qna/issues/18)) ([3616a3b](https://github.com/mohph197/pdf-qna/commit/3616a3b761aae2692c86c0d75b9b38ae9f5bd6f0))

## [1.3.1](https://github.com/mohph197/pdf-qna/compare/v1.3.0...v1.3.1) (2026-10-29)


### Bug Fixes

* **citations:** previews in ICLR papers and in PDFs without citation links ([#16](https://github.com/mohph197/pdf-qna/issues/16)) ([b89b45e](https://github.com/mohph197/pdf-qna/commit/b89b45ecf2e0f0f52c024dd4e0e94ff4b3fffe13))

## [1.3.0](https://github.com/mohph197/pdf-qna/compare/v1.2.0...v1.3.0) (2026-10-29)


### Features

* **sidebar:** ask about selected text and switch back to Chrome's PDF viewer ([#14](https://github.com/mohph197/pdf-qna/issues/14)) ([fc8ab34](https://github.com/mohph197/pdf-qna/commit/fc8ab3423067d48e5269e5edd320a419813751be))

## [1.2.0](https://github.com/mohph197/pdf-qna/compare/v1.1.0...v1.2.0) (2026-10-28)


### Features

* citation previews, paper info and Paper Q&A as the default PDF viewer ([#11](https://github.com/mohph197/pdf-qna/issues/11)) ([4170073](https://github.com/mohph197/pdf-qna/commit/41700736e689f8690ea319946ecbfb4e6c6ad32f))

## [1.1.0](https://github.com/mohph197/pdf-qna/compare/v1.0.0...v1.1.0) (2026-10-27)


### Features

* **sidebar:** Markdown export, optional web search and free-form answers ([#8](https://github.com/mohph197/pdf-qna/issues/8)) ([1cd700f](https://github.com/mohph197/pdf-qna/commit/1cd700fe595f9c7606dc611e41b40cd719326692))

## [1.0.0] - 2026-10-27

First public release.

- Opens PDFs (web or local) in a bundled pdf.js 6.4.299 viewer with a Q&A sidebar.
- Asks Claude (Opus 5.5 by default; Sonnet 5.5, Haiku 5.5 or Fable 5.1 are selectable) for short answers with 1–3 verbatim supporting quotes per question, as validated JSON. Malformed replies are retried once.
- Highlights quotes in the text layer, with one color per question. Clicking a quote scrolls to and flashes it.
- Robust quote matching across line breaks, hyphenation, ligatures, smart punctuation, page breaks, dropped citations, elisions and small wording changes. Approximate and low-confidence matches are labeled.
- Exports the PDF with highlights saved as standard PDF annotations.
- Caches answers per file (SHA-256), so reopening a paper restores them without an API call.
- Clear errors for a missing or invalid key, unknown models, rate limits, overload, refusals and papers too long for the model.
