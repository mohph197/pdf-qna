// Service worker: detects PDFs, offers the Q&A viewer, and makes all Claude
// API calls (the viewer page never sees the API key).

import { ClaudeError, askPaper, listModels } from "./claude.js";
import { ScholarError, lookupPaper } from "./scholar.js";
import { getSettings } from "../shared/models.js";

const BASE = chrome.runtime.getURL("");
const VIEWER = chrome.runtime.getURL("vendor/pdfjs/web/viewer.html");
const looksLikePdf = (url) => /^(https?|file):/i.test(url) && /\.pdf($|[?#])/i.test(url);

// The PDF's own fragment ("#page=3") becomes the viewer's, which pdf.js reads.
function viewerUrl(src) {
  if (!src) return VIEWER;
  const i = src.indexOf("#");
  return i < 0 ? `${VIEWER}?src=${encodeURIComponent(src)}` : `${VIEWER}?src=${encodeURIComponent(src.slice(0, i))}${src.slice(i)}`;
}

// ---------------------------------------------------------------------------
// Readable viewer URLs
//
// Once a PDF is open, the viewer rewrites its address to
// chrome-extension://<id>/https://example.com/paper.pdf, so the address bar
// shows (and copies) the PDF's own URL. Loading such an address, after a
// reload or from history, is routed back to the viewer here.

function viewerForPrettyUrl(url) {
  if (!url?.startsWith(BASE)) return null;
  const src = url.slice(BASE.length);
  return /^(https?|file):/i.test(src) ? viewerUrl(src) : null;
}

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  const target = viewerForPrettyUrl(event.request.url);
  if (target) event.respondWith(Response.redirect(target));
});

// ---------------------------------------------------------------------------
// PDF detection

// Remember tabs whose main document was served as application/pdf, which
// catches PDFs whose URL doesn't end in ".pdf" (e.g. arxiv.org/pdf/2005.14165).
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const header = (name) => details.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
    const type = header("content-type").toLowerCase();
    const attachment = /^\s*attachment/i.test(header("content-disposition"));
    const isPdf = type.includes("application/pdf") || (type.includes("octet-stream") && looksLikePdf(details.url));
    if (isPdf && !attachment) {
      chrome.storage.session.set({ [`pdf:${details.tabId}`]: details.url });
      // Open it in the viewer before Chrome's own viewer shows it. A POST
      // response can't be fetched again, so those stay in Chrome's viewer.
      if (details.method === "GET") autoOpen(details.tabId, details.url);
    }
  },
  { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
  ["responseHeaders"],
);

async function isPdfTab(tab) {
  if (!tab?.url || tab.url.startsWith(VIEWER)) return false;
  if (looksLikePdf(tab.url)) return true;
  const key = `pdf:${tab.id}`;
  const stored = (await chrome.storage.session.get(key))[key];
  return stored === tab.url;
}

// "Always open" mode makes Paper Q&A the default PDF viewer. The tab's last
// automatically opened PDF is remembered so that going Back to it shows the
// PDF itself instead of bouncing into the viewer again; the memory is cleared
// once the tab goes elsewhere.
async function autoOpen(tabId, url) {
  const { openMode } = await getSettings();
  if (openMode !== "always") return;
  const key = `auto:${tabId}`;
  if ((await chrome.storage.session.get(key))[key] === url) return;
  await chrome.storage.session.set({ [key]: url });
  chrome.tabs.update(tabId, { url: viewerUrl(url) }).catch(() => {});
}

chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (change.url && !change.url.startsWith(BASE)) {
    const key = `auto:${tabId}`;
    const last = (await chrome.storage.session.get(key))[key];
    if (last && last !== change.url) chrome.storage.session.remove(key);
  }
  // Local files send no response headers to watch, so catch them here.
  if (change.status === "loading" && /^file:/i.test(tab.url ?? "") && looksLikePdf(tab.url)) autoOpen(tabId, tab.url);
  if (change.status !== "complete") return;
  // A hard reload (which skips the service worker) of a readable viewer URL
  // ends on an error page. If no extension page runs in the tab, reroute it.
  const rerouted = viewerForPrettyUrl(tab.url);
  if (rerouted) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"], tabIds: [tabId] });
    if (!contexts.length) chrome.tabs.update(tabId, { url: rerouted });
    return;
  }
  if (!(await isPdfTab(tab))) {
    chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }
  const { openMode } = await getSettings();
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#d97706" });
  chrome.action.setBadgeText({ tabId, text: "Q&A" });
  chrome.action.setTitle({ tabId, title: "Open this PDF in Paper Q&A" });
  // In "always" mode a PDF only stays in Chrome's viewer when the user came
  // back to it, so offer the viewer instead of forcing it.
  if (openMode !== "never") offer(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove([`pdf:${tabId}`, `auto:${tabId}`]));

async function offer(tab) {
  // Preferred: a small banner inside the tab. Chrome's PDF viewer may refuse
  // script injection; fall back to a system notification in that case.
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: showBanner });
  } catch {
    chrome.notifications.create(`offer:${tab.id}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Paper Q&A",
      message: "Ask questions about this PDF and highlight the answers.",
      buttons: [{ title: "Open in Paper Q&A" }],
      priority: 0,
    });
  }
}

// Injected into the PDF tab. Must be self-contained.
function showBanner() {
  if (document.getElementById("paper-qa-offer")) return;
  const bar = document.createElement("div");
  bar.id = "paper-qa-offer";
  bar.style.cssText =
    "position:fixed;top:12px;right:12px;z-index:2147483647;display:flex;gap:8px;align-items:center;" +
    "padding:10px 12px;border-radius:10px;background:#1f2937;color:#f9fafb;font:13px system-ui,sans-serif;" +
    "box-shadow:0 6px 24px rgba(0,0,0,.3)";
  const label = document.createElement("span");
  label.textContent = "Ask questions about this paper?";
  const open = document.createElement("button");
  open.textContent = "Open in Paper Q&A";
  open.style.cssText =
    "border:0;border-radius:6px;padding:6px 10px;background:#f59e0b;color:#111827;font-weight:600;cursor:pointer";
  open.onclick = () => chrome.runtime.sendMessage({ type: "openViewer" });
  const always = document.createElement("button");
  always.textContent = "Always";
  always.title = "Open every PDF in Paper Q&A (make it the default PDF viewer). Change this in the extension's options.";
  always.style.cssText =
    "border:1px solid #4b5563;border-radius:6px;padding:5px 9px;background:none;color:#f9fafb;cursor:pointer";
  always.onclick = () => chrome.runtime.sendMessage({ type: "openViewer", always: true });
  const close = document.createElement("button");
  close.textContent = "✕";
  close.title = "Dismiss";
  close.style.cssText = "border:0;background:none;color:#9ca3af;cursor:pointer;font-size:14px";
  close.onclick = () => bar.remove();
  bar.append(label, open, always, close);
  document.documentElement.append(bar);
}

chrome.notifications.onButtonClicked.addListener(async (id) => {
  if (!id.startsWith("offer:")) return;
  const tabId = Number(id.slice(6));
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) chrome.tabs.update(tabId, { url: viewerUrl(tab.url), active: true });
  chrome.notifications.clear(id);
});

chrome.action.onClicked.addListener(async (tab) => {
  if (await isPdfTab(tab)) chrome.tabs.update(tab.id, { url: viewerUrl(tab.url) });
  else if (!tab.url?.startsWith(VIEWER)) chrome.tabs.create({ url: viewerUrl() });
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "open-link",
    title: "Open PDF in Paper Q&A",
    contexts: ["link"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "open-link" && info.linkUrl) {
    chrome.tabs.create({ url: viewerUrl(info.linkUrl), index: tab ? tab.index + 1 : undefined });
  }
});

// ---------------------------------------------------------------------------
// Messages from the banner, options page and viewer

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "openViewer" && sender.tab) {
    if (msg.always) chrome.storage.local.set({ openMode: "always" });
    chrome.tabs.update(sender.tab.id, { url: viewerUrl(sender.tab.url) });
    return;
  }
  if (msg?.type === "lookupPaper") {
    getSettings()
      .then((s) => lookupPaper(msg.query ?? {}, { apiKey: s.s2ApiKey }))
      .then((paper) => sendResponse({ ok: true, paper }))
      .catch((e) => {
        const err = e instanceof ScholarError ? e : new ScholarError("error", e?.message ?? String(e));
        sendResponse({ ok: false, error: { code: err.code, message: err.message } });
      });
    return true; // async response
  }
  if (msg?.type === "listModels") {
    getSettings()
      .then((s) => listModels(msg.apiKey ?? s.apiKey))
      .then((models) => sendResponse({ ok: true, models }))
      .catch((e) => sendResponse({ ok: false, error: { code: e.code ?? "error", message: e.message } }));
    return true; // async response
  }
});

// The viewer asks questions over a long-lived port. Streaming progress
// messages keep the service worker alive for the length of the request, and
// closing the viewer tab aborts the request.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ask") return;
  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());
  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== "ask") return;
    const post = (m) => {
      try {
        port.postMessage(m);
      } catch {
        /* viewer went away */
      }
    };
    try {
      const settings = await getSettings();
      let lastProgress = 0;
      const result = await askPaper({
        apiKey: settings.apiKey,
        model: settings.model,
        effort: settings.effort,
        pageTexts: msg.pageTexts,
        questions: msg.questions,
        signal: controller.signal,
        onStatus: (text) => post({ type: "status", text }),
        onDelta: (chars) => {
          if (chars - lastProgress >= 200) {
            lastProgress = chars;
            post({ type: "progress", chars });
          }
        },
      });
      post({ type: "result", ...result });
    } catch (e) {
      const err = e instanceof ClaudeError ? e : new ClaudeError("error", e?.message ?? String(e));
      post({ type: "error", error: { code: err.code, message: err.message } });
    }
  });
});
