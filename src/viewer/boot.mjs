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
    // qa.mjs rewrites the address to chrome-extension://<id>/<PDF URL>, so
    // relative resource paths (fonts, CMaps, the worker) must not depend on it.
    for (const name of ["cMapUrl", "iccUrl", "imageResourcesPath", "standardFontDataUrl", "wasmUrl", "workerSrc"]) {
      const value = opts.get(name);
      if (typeof value === "string" && value) opts.set(name, new URL(value, location.href).href);
    }
  },
  { once: true },
);
