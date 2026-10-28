// Model catalogue shown on the options page. IDs and prices come from
// Anthropic's model docs (checked 2026-10). The options page can also load
// the live list from GET /v1/models, so new models show up without an update.
// webSearch is the web search tool version: the dynamic-filtering one where
// the docs list support, the basic one otherwise.

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (recommended)", context: 1_000_000, input: 4, fallbacks: true, webSearch: "web_search_20260209" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (faster, cheaper)", context: 1_000_000, input: 2, fallbacks: true, webSearch: "web_search_20260209" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest, cheapest)", context: 1_000_000, input: 0.1, fallbacks: false, webSearch: "web_search_20250305" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1 (most capable, priciest)", context: 1_000_000, input: 10, fallbacks: true, webSearch: "web_search_20260209" },
];

export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_EFFORT = "medium";
export const EFFORTS = ["low", "medium", "high"];

export function modelInfo(id) {
  return (
    MODELS.find((m) => m.id === id) ?? {
      id,
      label: id,
      context: 200_000, // conservative guess for models not in the list
      input: null,
      fallbacks: false,
      webSearch: "web_search_20250305",
    }
  );
}

export const DEFAULT_SETTINGS = {
  apiKey: "",
  model: DEFAULT_MODEL,
  effort: DEFAULT_EFFORT,
  openMode: "ask", // "ask" | "always" | "never": what to do when a PDF opens
  citationPreviews: true, // clicking a citation shows the cited paper
  s2ApiKey: "", // optional Semantic Scholar API key for paper lookups
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...stored };
}
