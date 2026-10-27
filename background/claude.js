// Claude Messages API client used by the service worker.
// Raw fetch (no SDK) because the extension has no build step.

import { modelInfo } from "../shared/models.js";
import { ANSWER_SCHEMA, SYSTEM_PROMPT, buildUserContent, parseAnswers } from "../shared/prompt.js";

const API = "https://api.anthropic.com/v1";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class ClaudeError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

function headers(apiKey, betas = []) {
  const h = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  };
  if (betas.length) h["anthropic-beta"] = betas.join(",");
  return h;
}

/** Rough token estimate (~3.5 chars/token for English prose). */
export function estimateTokens(chars) {
  return Math.ceil(chars / 3.5);
}

async function errorFromResponse(res, model) {
  let message = "";
  let type = "";
  try {
    const body = await res.json();
    message = body?.error?.message ?? "";
    type = body?.error?.type ?? "";
  } catch {
    /* non-JSON error body */
  }
  const retryAfter = Number(res.headers.get("retry-after")) || null;
  switch (res.status) {
    case 401:
      return new ClaudeError("auth", "Your API key was rejected. Check it on the options page.");
    case 403:
      return new ClaudeError("permission", `Your API key isn't allowed to do this: ${message || "permission denied"}`);
    case 404:
      return new ClaudeError("model", `Model "${model}" isn't available to your API key. Pick another model on the options page.`);
    case 413:
      return new ClaudeError("too_long", "This PDF is too large to send in one request (over the 32 MB request limit).");
    case 429:
      return new ClaudeError(
        "rate_limit",
        `Rate limited by the Anthropic API${retryAfter ? `; try again in ${retryAfter}s` : ""}. ${message}`.trim(),
        { retryAfter, retryable: true },
      );
    case 529:
      return new ClaudeError("overloaded", "The Anthropic API is overloaded right now. Try again shortly.", {
        retryAfter,
        retryable: true,
      });
    default:
      if (res.status === 400 && /prompt is too long|too many tokens|context window/i.test(message)) {
        return new ClaudeError("too_long", `This paper is too long for ${model}'s context window. ${message}`);
      }
      if (res.status === 400 && /web.?search/i.test(message)) {
        return new ClaudeError(
          "web_disabled",
          "Web search isn't available to your API key. An admin can enable it in the Claude Console under Settings > Capabilities; " +
            `otherwise ask without "Search the web". (${message})`,
        );
      }
      if (res.status === 400 && /output_config|json_schema|format/i.test(message)) {
        return new ClaudeError("schema_unsupported", message);
      }
      return new ClaudeError(
        res.status >= 500 ? "server" : "api",
        `Anthropic API error ${res.status}${type ? ` (${type})` : ""}: ${message || res.statusText}`,
        { retryable: res.status >= 500 },
      );
  }
}

// Blocks that mark a tool round trip; the reply's text is what follows the last one.
const TEXT_LIKE = new Set(["text", "thinking", "redacted_thinking"]);

/**
 * One streamed request. Returns { text, stopReason, model, usage, content,
 * searchResults }: content is the reconstructed list of content blocks (sent
 * back to resume after pause_turn), searchResults maps each web search result
 * or citation url to its title. onDelta(totalChars) is called as text arrives.
 */
async function streamMessage({ apiKey, body, betas, signal, onDelta }) {
  let res;
  try {
    res = await fetch(`${API}/messages`, {
      method: "POST",
      headers: headers(apiKey, betas),
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw new ClaudeError("aborted", "Request cancelled.");
    throw new ClaudeError("network", `Couldn't reach the Anthropic API: ${e.message}`, { retryable: true });
  }
  if (!res.ok) throw await errorFromResponse(res, body.model);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let blockType = null;
  let block = null;
  let partialJson = "";
  let stopReason = null;
  let model = body.model;
  const usage = {};
  const content = [];
  const searchResults = new Map();
  const addSource = (r) => r?.url && !searchResults.get(r.url) && searchResults.set(r.url, r.title ?? "");

  const handle = (evt) => {
    switch (evt.type) {
      case "message_start":
        model = evt.message?.model ?? model;
        Object.assign(usage, evt.message?.usage);
        break;
      case "content_block_start":
        blockType = evt.content_block?.type;
        // A server-side fallback restarts generation on another model;
        // whatever the refusing model streamed before it must be discarded.
        if (blockType === "fallback") {
          text = "";
          content.length = 0;
          block = null;
          model = evt.content_block?.model ?? model;
          break;
        }
        if (!TEXT_LIKE.has(blockType)) text = "";
        block = structuredClone(evt.content_block ?? {});
        partialJson = "";
        content.push(block);
        if (blockType === "web_search_tool_result" && Array.isArray(block.content)) block.content.forEach(addSource);
        break;
      case "content_block_delta": {
        const d = evt.delta ?? {};
        if (d.type === "text_delta" && blockType === "text") {
          text += d.text;
          block.text = (block.text ?? "") + d.text;
          onDelta?.(text.length);
        } else if (d.type === "thinking_delta" && block) {
          block.thinking = (block.thinking ?? "") + d.thinking;
        } else if (d.type === "signature_delta" && block) {
          block.signature = d.signature;
        } else if (d.type === "input_json_delta") {
          partialJson += d.partial_json;
        } else if (d.type === "citations_delta" && block) {
          (block.citations ??= []).push(d.citation);
          addSource(d.citation);
        }
        break;
      }
      case "content_block_stop":
        if (block && partialJson) {
          try {
            block.input = JSON.parse(partialJson);
          } catch {
            /* keep the input from content_block_start */
          }
        }
        partialJson = "";
        break;
      case "message_delta":
        stopReason = evt.delta?.stop_reason ?? stopReason;
        Object.assign(usage, evt.usage);
        break;
      case "error": {
        const t = evt.error?.type;
        if (t === "overloaded_error") {
          throw new ClaudeError("overloaded", "The Anthropic API is overloaded right now. Try again shortly.", {
            retryable: true,
          });
        }
        if (t === "rate_limit_error") throw new ClaudeError("rate_limit", "Rate limited by the Anthropic API.", { retryable: true });
        throw new ClaudeError("api", `Anthropic API error: ${evt.error?.message ?? t ?? "unknown"}`);
      }
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = chunk
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (data) handle(JSON.parse(data));
      }
    }
  } catch (e) {
    if (e instanceof ClaudeError) throw e;
    if (e.name === "AbortError") throw new ClaudeError("aborted", "Request cancelled.");
    throw new ClaudeError("network", `The connection to the Anthropic API dropped: ${e.message}`, { retryable: true });
  }
  return { text, stopReason, model, usage, content, searchResults };
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new ClaudeError("aborted", "Request cancelled."));
    });
  });

/** streamMessage with retries for rate limits, overload and transient errors. */
async function streamWithRetry(args, onStatus) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await streamMessage(args);
    } catch (e) {
      if (!e.retryable || attempt >= 2) throw e;
      const wait = e.retryAfter ?? 5 * 2 ** attempt;
      if (wait > 60) throw e; // long waits are better reported than silently blocked on
      onStatus?.(`${e.code === "rate_limit" ? "Rate limited" : "API busy"}; retrying in ${wait}s…`);
      await sleep(wait * 1000, args.signal);
    }
  }
}

/**
 * Ask questions about a paper.
 * @param {object} p
 * @param {string[]} p.pageTexts  text of every page, in order
 * @param {{ text: string, web?: boolean, freeform?: boolean }[]} p.questions
 *   web: may use web search; freeform: answer in any format, quotes optional
 * @returns {Promise<{answers, model, usage, webSearches}>}
 */
export async function askPaper({ apiKey, model, effort, pageTexts, questions, signal, onStatus, onDelta }) {
  if (!apiKey) {
    throw new ClaudeError("no_key", "No Anthropic API key set. Add one on the options page.");
  }
  const info = modelInfo(model);
  const chars = pageTexts.reduce((a, t) => a + t.length, 0);
  const tokens = estimateTokens(chars);
  if (tokens > info.context * 0.9) {
    throw new ClaudeError(
      "too_long",
      `This PDF has about ${Math.round(tokens / 1000)}k tokens of text, more than ${model} can read at once ` +
        `(${Math.round(info.context / 1000)}k). Try a shorter document or split it.`,
    );
  }

  const betas = info.fallbacks ? [FALLBACK_BETA] : [];
  const webAllowed = questions.map((q) => !!q.web);
  const freeform = questions.map((q) => !!q.freeform);
  const tools = webAllowed.some(Boolean) ? [{ type: info.webSearch, name: "web_search", max_uses: 5 }] : [];
  let useSchema = true;
  const base = () => ({
    model,
    // Free-form answers (tables, extractions) can be much longer than short ones.
    max_tokens: freeform.some(Boolean) ? 32000 : 16000,
    system: SYSTEM_PROMPT,
    output_config: {
      effort,
      ...(useSchema ? { format: { type: "json_schema", schema: ANSWER_SCHEMA } } : {}),
    },
    ...(tools.length ? { tools } : {}),
    // Re-run on a fallback model server-side if a safety classifier declines.
    ...(info.fallbacks ? { fallbacks: "default" } : {}),
  });

  const messages = [{ role: "user", content: buildUserContent(pageTexts, questions) }];
  let usageTotal = {};
  let webSearches = 0;
  const searchResults = new Map();

  for (let attempt = 0; attempt < 2; attempt++) {
    onStatus?.(attempt === 0 ? `Asking ${model}…` : "Response was malformed; asking again…");
    let reply;
    try {
      const send = (msgs) => streamWithRetry({ apiKey, body: { ...base(), messages: msgs }, betas, signal, onDelta }, onStatus);
      reply = await send(messages);
      // A long web search turn can pause; sending the partial turn back resumes it.
      let turn = [];
      for (let resumes = 0; ; resumes++) {
        webSearches += reply.usage?.server_tool_use?.web_search_requests ?? 0;
        for (const [url, title] of reply.searchResults) if (!searchResults.get(url)) searchResults.set(url, title);
        if (reply.stopReason !== "pause_turn" || resumes >= 3) break;
        turn = [...turn, ...reply.content];
        onStatus?.("Searching the web…");
        reply = await send([...messages, { role: "assistant", content: turn }]);
      }
    } catch (e) {
      if (e.code === "schema_unsupported" && useSchema) {
        // Older or proxied models may reject structured outputs; the system
        // prompt still asks for JSON and the validator below checks it.
        useSchema = false;
        attempt--;
        continue;
      }
      throw e;
    }
    usageTotal = reply.usage;

    if (reply.stopReason === "refusal") {
      throw new ClaudeError("refusal", "Claude declined to answer these questions about this document.");
    }
    try {
      const answers = parseAnswers(reply.text, questions.length, pageTexts.length, { webAllowed, freeform, searchResults });
      return { answers, model: reply.model, usage: usageTotal, webSearches };
    } catch (e) {
      if (attempt === 1) {
        throw new ClaudeError(
          "bad_response",
          `Claude's reply couldn't be used after a retry: ${e.message}` +
            (reply.stopReason === "max_tokens" ? " (the reply was cut off; try fewer questions at once)" : ""),
        );
      }
      // Retry once, showing the model what was wrong.
      messages.push({ role: "assistant", content: reply.text || "(empty)" });
      messages.push({
        role: "user",
        content: `That reply can't be used: ${e.message} Reply again with only the JSON object described in the instructions, covering all ${questions.length} questions.`,
      });
    }
  }
  throw new ClaudeError("bad_response", "Unreachable");
}

/** List models available to the key (for the options page). */
export async function listModels(apiKey) {
  if (!apiKey) throw new ClaudeError("no_key", "Enter an API key first.");
  let res;
  try {
    res = await fetch(`${API}/models?limit=100`, { headers: headers(apiKey) });
  } catch (e) {
    throw new ClaudeError("network", `Couldn't reach the Anthropic API: ${e.message}`);
  }
  if (!res.ok) throw await errorFromResponse(res, "");
  const body = await res.json();
  return body.data.map((m) => ({ id: m.id, label: m.display_name ?? m.id, context: m.max_input_tokens ?? null }));
}
