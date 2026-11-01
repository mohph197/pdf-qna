// Claude Code backend: sends requests to the user's own Claude Code
// installation through a native messaging host (native-host/) instead of
// calling the Claude API with a key. Each request opens its own connection,
// which starts the host; disconnecting stops it and the claude process.

import { ClaudeError } from "./claude.js";

export const HOST = "com.paperqa.claude_code";
const DONE = new Set(["result", "pong", "launched"]);
// The prompts in shared/ name the API's server tools.
const WEB_TOOLS_NOTE = "Here the web_search and web_fetch tools are called WebSearch and WebFetch.";

function hostError(message = "") {
  if (/not found|forbidden/i.test(message)) {
    return new ClaudeError(
      "claude_code_setup",
      "Paper Q&A's Claude Code helper isn't installed for this browser. Set it up on the options page.",
    );
  }
  return new ClaudeError("claude_code", `The Claude Code helper stopped unexpectedly${message ? `: ${message}` : "."}`);
}

/** Sends one message to the host; resolves with its final reply. onMessage gets the rest. */
function callHost(message, { signal, onMessage } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ClaudeError("aborted", "Request cancelled."));
    let port;
    try {
      port = chrome.runtime.connectNative(HOST);
    } catch (e) {
      return reject(hostError(e.message));
    }
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      try {
        port.disconnect();
      } catch {
        /* already closed */
      }
      fn(value);
    };
    const abort = () => finish(reject, new ClaudeError("aborted", "Request cancelled."));
    signal?.addEventListener("abort", abort);
    port.onMessage.addListener((msg) => {
      if (msg.type === "error") finish(reject, new ClaudeError(msg.code ?? "claude_code", msg.message));
      else if (DONE.has(msg.type)) finish(resolve, msg);
      else onMessage?.(msg);
    });
    port.onDisconnect.addListener(() => finish(reject, hostError(chrome.runtime.lastError?.message)));
    port.postMessage(message);
  });
}

/** For the options page: is the helper installed, and where is claude? */
export async function claudeCodeStatus() {
  const { claude, version } = await callHost({ type: "ping" });
  if (!claude) {
    throw new ClaudeError(
      "claude_code_missing",
      "The helper is installed, but Claude Code wasn't found. Install it, then run the install command again.",
    );
  }
  return { claude, version };
}

function resultError(reply) {
  const detail = [reply.text, ...(reply.errors ?? [])].filter(Boolean).join(" ").trim() || reply.subtype || "unknown error";
  if (/not logged in|\/login|invalid api key|authenticat|oauth/i.test(detail)) {
    return new ClaudeError("claude_code_auth", `Claude Code isn't logged in. Run claude in a terminal and log in, then try again. (${detail})`);
  }
  if (/usage limit|rate.?limit/i.test(detail)) return new ClaudeError("rate_limit", `Claude Code: ${detail}`);
  if (/model/i.test(detail) && /not (found|available|exist)|invalid|unknown/i.test(detail)) {
    return new ClaudeError("model", `Claude Code can't use this model: ${detail} Pick another model on the options page.`);
  }
  if (reply.subtype === "error_max_turns") return new ClaudeError("claude_code", "Claude Code used up its turns before replying. Try again.");
  if (reply.subtype === "error_max_structured_output_retries") {
    return new ClaudeError("bad_response", "Claude Code couldn't produce a reply in the expected format. Try again.");
  }
  return new ClaudeError("claude_code", `Claude Code error: ${detail}`);
}

/**
 * askJson (claude.js) through Claude Code: the system prompt replaces Claude
 * Code's own, the schema becomes --json-schema, and web search and web fetch
 * are its only tools when the request allows the web. Malformed replies are
 * retried once, showing Claude what was wrong.
 */
export async function askClaudeCode({ model, effort, system, schema, content, web, parse, status, retryHint, refusal, signal, onStatus, onDelta }) {
  const paper = content.map((block) => block.text).join("\n\n");
  let prompt = paper;
  for (let attempt = 0; attempt < 2; attempt++) {
    onStatus?.(attempt === 0 ? `${status.replace(/…$/, "")} via Claude Code…` : "Response was malformed; asking again…");
    const searchResults = new Map();
    let replyModel = model;
    let webSearches = 0;
    let webFetches = 0;
    const reply = await callHost(
      { type: "run", system: web ? `${system}\n\n${WEB_TOOLS_NOTE}` : system, prompt, schema, model, effort, web },
      {
        signal,
        onMessage: (msg) => {
          if (msg.type === "progress") onDelta?.(msg.chars);
          else if (msg.type === "model") replyModel = msg.model || replyModel;
          else if (msg.type === "sources") {
            for (const s of msg.sources) if (s.url && !searchResults.get(s.url)) searchResults.set(s.url, s.title ?? "");
          } else if (msg.type === "tool" && msg.name === "WebSearch") {
            webSearches++;
            onStatus?.("Searching the web…");
          } else if (msg.type === "tool" && msg.name === "WebFetch") {
            webFetches++;
            let host = "a web page";
            try {
              host = new URL(msg.url).host;
            } catch {
              /* keep the generic name */
            }
            onStatus?.(`Reading ${host}…`);
          }
        },
      },
    );
    if (reply.stopReason === "refusal") throw new ClaudeError("refusal", refusal);
    if (reply.isError) throw resultError(reply);
    const text = reply.structured != null ? JSON.stringify(reply.structured) : reply.text;
    try {
      return { data: parse(text, searchResults), model: replyModel, usage: reply.usage, webSearches, webFetches };
    } catch (e) {
      if (attempt === 1) throw new ClaudeError("bad_response", `Claude's reply couldn't be used after a retry: ${e.message}`);
      prompt = `${paper}\n\nYour previous reply was:\n${text || "(empty)"}\n\nThat reply can't be used: ${e.message} ${retryHint}`;
    }
  }
  throw new ClaudeError("bad_response", "Unreachable");
}

/**
 * Creates a project folder with the implementation prompt and the paper, and
 * starts Claude Code on it in a terminal window.
 * @param {object} p
 * @param {string} p.dir  folder to create the project in ("~" allowed)
 * @param {string} p.name  the system being implemented, for the folder name
 * @param {string} p.prompt  the implementation prompt
 * @param {string} [p.pdf]  the paper, base64-encoded
 * @returns {Promise<{dir: string}>}  the project folder
 */
export async function launchClaudeCode({ dir, name, prompt, pdf, signal, onStatus }) {
  onStatus?.("Starting Claude Code…");
  const reply = await callHost({ type: "launch", dir, name, prompt, pdf }, { signal });
  return { dir: reply.dir };
}
