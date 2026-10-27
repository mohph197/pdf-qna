# Third-party notices

Paper Q&A bundles the following libraries in `vendor/`. Each keeps its own license; the full texts ship next to the code.

| Library | Version | License | License file |
| --- | --- | --- | --- |
| [pdf.js](https://github.com/mozilla/pdf.js) (Mozilla) | 6.4.299 | Apache License 2.0 | `vendor/pdfjs/LICENSE` |
| pdf.js image decoders: OpenJPEG, JBIG2, QCMS (WebAssembly builds) | bundled with pdf.js 6.4.299 | BSD-2-Clause, BSD-3-Clause, Apache-2.0 and MIT (see files) | `vendor/pdfjs/web/wasm/LICENSE_*` |
| Adobe CMaps (in pdf.js) | bundled with pdf.js 6.4.299 | BSD-3-Clause | `vendor/pdfjs/web/cmaps/LICENSE` |
| Standard fonts: Foxit and Liberation (in pdf.js) | bundled with pdf.js 6.4.299 | BSD-3-Clause (Foxit), Liberation font license (see file) | `vendor/pdfjs/web/standard_fonts/LICENSE_*` |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | MIT | `vendor/pdf-lib/LICENSE.md` |

Changes made to pdf.js (applied by `scripts/vendor.sh`):

- `web/viewer.html` loads the Paper Q&A sidebar scripts and stylesheet, and its Content Security Policy also allows `file:` URLs so local PDFs can be read.
- Source maps, the demo PDF, the debugger, and the PDF-JavaScript sandbox (`pdf.sandbox.mjs`, `quickjs-eval.*`) are removed. Scripts embedded in PDFs are never run.
