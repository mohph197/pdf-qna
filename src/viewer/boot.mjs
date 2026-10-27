// Runs before pdf.js's viewer.mjs. The stock viewer opens ?file=… itself and
// refuses cross-origin URLs, so we disable that and load documents ourselves
// (see qa.mjs), passing ?src=… instead.
document.addEventListener(
  "webviewerloaded",
  () => {
    const opts = window.PDFViewerApplicationOptions;
    opts.set("defaultUrl", "");
    opts.set("isEvalSupported", false); // extension CSP forbids eval
    // Never run JavaScript embedded in PDFs (the sandbox isn't shipped).
    opts.set("enableScripting", false);
  },
  { once: true },
);
