// Service worker: detects PDFs, offers the Q&A viewer, and makes all Claude
// API calls (the viewer page never sees the API key).

import { ClaudeError, askPaper, listModels } from "./claude.js";
import { getSettings } from "../shared/models.js";

const VIEWER = chrome.runtime.getURL("vendor/pdfjs/web/viewer.html");
const viewerUrl = (src) => (src ? `${VIEWER}?src=${encodeURIComponent(src)}` : VIEWER);
const looksLikePdf = (url) => /^(https?|file):/i.test(url) && /\.pdf($|[?#])/i.test(url);

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

chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (change.status !== "complete") return;
  if (!(await isPdfTab(tab))) {
    chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }
  const { openMode } = await getSettings();
  if (openMode === "always") {
    chrome.tabs.update(tabId, { url: viewerUrl(tab.url) });
    return;
  }
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#d97706" });
  chrome.action.setBadgeText({ tabId, text: "Q&A" });
  chrome.action.setTitle({ tabId, title: "Open this PDF in Paper Q&A" });
  if (openMode === "ask") offer(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(`pdf:${tabId}`));

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
  const close = document.createElement("button");
  close.textContent = "✕";
  close.title = "Dismiss";
  close.style.cssText = "border:0;background:none;color:#9ca3af;cursor:pointer;font-size:14px";
  close.onclick = () => bar.remove();
  bar.append(label, open, close);
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
    chrome.tabs.update(sender.tab.id, { url: viewerUrl(sender.tab.url) });
    return;
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
