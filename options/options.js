import { MODELS, getSettings, modelInfo } from "../shared/models.js";

const $ = (id) => document.getElementById(id);

function fillModels(models, selected) {
  const select = $("model");
  select.replaceChildren();
  const ids = new Set();
  for (const m of models) {
    if (ids.has(m.id)) continue;
    ids.add(m.id);
    select.append(new Option(m.label === m.id ? m.id : `${m.label} (${m.id})`, m.id));
  }
  if (selected && !ids.has(selected)) select.append(new Option(selected, selected));
  select.value = selected;
  updateModelHint();
}

function updateModelHint() {
  const info = modelInfo($("model").value);
  $("modelHint").textContent = info.input
    ? `Input costs about $${info.input} per million tokens; a typical 15-page paper is ~15k tokens.`
    : "";
}

async function refreshCacheInfo() {
  const all = await chrome.storage.local.get(null);
  const docs = Object.keys(all).filter((k) => k.startsWith("doc:"));
  $("cacheInfo").textContent = `${docs.length} paper${docs.length === 1 ? "" : "s"} cached.`;
}

async function init() {
  const s = await getSettings();
  $("apiKey").value = s.apiKey;
  $("effort").value = s.effort;
  $("openMode").value = s.openMode;
  $("citationPreviews").checked = s.citationPreviews;
  $("s2ApiKey").value = s.s2ApiKey;
  fillModels(MODELS, s.model);
  refreshCacheInfo();
  chrome.extension.isAllowedFileSchemeAccess((allowed) => {
    $("fileAccess").textContent = allowed ? " ✓ Currently allowed." : " ✗ Currently not allowed.";
  });
}

$("model").addEventListener("change", updateModelHint);

$("toggleKey").addEventListener("click", () => {
  const input = $("apiKey");
  input.type = input.type === "password" ? "text" : "password";
  $("toggleKey").textContent = input.type === "password" ? "Show" : "Hide";
});

$("loadModels").addEventListener("click", async () => {
  const hint = $("modelHint");
  hint.textContent = "Checking key…";
  const res = await chrome.runtime.sendMessage({ type: "listModels", apiKey: $("apiKey").value.trim() });
  if (!res?.ok) {
    hint.textContent = `✗ ${res?.error?.message ?? "Request failed."}`;
    return;
  }
  const known = new Map(MODELS.map((m) => [m.id, m]));
  const live = res.models.filter((m) => m.id.startsWith("claude-"));
  // Known models first (with our labels), then anything else the key can use.
  const ordered = [
    ...MODELS.filter((m) => live.some((l) => l.id === m.id)),
    ...live.filter((l) => !known.has(l.id)),
  ];
  fillModels(ordered.length ? ordered : MODELS, $("model").value);
  hint.textContent = `✓ Key works. ${live.length} models available.`;
});

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    apiKey: $("apiKey").value.trim(),
    model: $("model").value,
    effort: $("effort").value,
    openMode: $("openMode").value,
    citationPreviews: $("citationPreviews").checked,
    s2ApiKey: $("s2ApiKey").value.trim(),
  });
  $("saved").textContent = "Saved.";
  setTimeout(() => ($("saved").textContent = ""), 2000);
});

$("clearCache").addEventListener("click", async () => {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith("doc:")));
  refreshCacheInfo();
});

init();
