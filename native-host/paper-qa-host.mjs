#!/usr/bin/env node
// Native messaging host for Paper Q&A's "Claude Code" backend. Chrome starts
// it once per connection from the service worker; it runs the user's own
// Claude Code installation instead of calling the Claude API with a key.
//
//   { type: "ping" }    -> { type: "pong", host, claude, version }
//   { type: "run", system, prompt, schema, model, effort, web }
//                       -> status messages, then { type: "result", ... }
//   { type: "launch", dir, name, prompt, pdf }
//                       -> { type: "launched", dir }: a new project folder
//                          with the prompt and paper, and Claude Code
//                          started on it in a terminal window
//
// Failures are sent as { type: "error", code, message }. Installed by
// install.sh, which records where node and claude are. Set PAPER_QA_TERMINAL
// to a program to open projects with it instead of the default terminal; it
// gets a shell script to run as its only argument.

import { execFile, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const HOST_VERSION = 1;
const KICKOFF = "Read IMPLEMENTATION_PROMPT.md and carry it out. The paper it describes is paper.pdf in this folder.";
// Chrome rejects messages from a host larger than 1 MB.
const MAX_MESSAGE = 1024 * 1024 - 1024;

let child = null;

// ---------------------------------------------------------------------------
// Native messaging framing: a 32-bit length in native byte order (little
// endian on every platform Chrome supports), then that many bytes of JSON.

function send(msg) {
  let body = Buffer.from(JSON.stringify(msg));
  if (body.length > MAX_MESSAGE) {
    body = Buffer.from(JSON.stringify({ type: "error", code: "too_long", message: "Claude Code's reply is too large to pass to the browser." }));
  }
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([head, body]));
}

let input = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const length = input.readUInt32LE(0);
    if (input.length < 4 + length) break;
    const msg = JSON.parse(input.subarray(4, 4 + length).toString("utf8"));
    input = input.subarray(4 + length);
    handle(msg).catch((e) => send({ type: "error", code: e.code ?? "claude_code", message: e.message }));
  }
});
// The browser closed the connection (request cancelled or tab closed).
process.stdin.on("end", () => {
  child?.kill();
  process.exit(0);
});

class HostError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function handle(msg) {
  if (msg?.type === "ping") return ping();
  if (msg?.type === "run") return run(msg);
  if (msg?.type === "launch") return launch(msg);
  throw new HostError("claude_code", `Unknown request "${msg?.type}". Update the Claude Code helper (native-host/install.sh).`);
}

// ---------------------------------------------------------------------------
// Finding claude

const isExecutable = (path) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

function findClaude() {
  if (process.env.CLAUDE_PATH && isExecutable(process.env.CLAUDE_PATH)) return process.env.CLAUDE_PATH;
  const dirs = [
    ...(process.env.PATH ?? "").split(delimiter),
    join(homedir(), ".local/bin"),
    join(homedir(), ".claude/local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of dirs) {
    if (dir && isExecutable(join(dir, "claude"))) return join(dir, "claude");
  }
  return null;
}

function requireClaude() {
  const claude = findClaude();
  if (!claude) {
    throw new HostError(
      "claude_code_missing",
      "Claude Code wasn't found on this computer. Install it (https://claude.com/claude-code), then run native-host/install.sh again.",
    );
  }
  return claude;
}

async function ping() {
  const claude = findClaude();
  const version = claude
    ? await new Promise((resolve) =>
        execFile(claude, ["--version"], { timeout: 15_000 }, (err, stdout) => resolve(err ? null : stdout.trim())),
      )
    : null;
  send({ type: "pong", host: HOST_VERSION, claude, version });
}

// ---------------------------------------------------------------------------
// One headless request: claude -p with a replaced system prompt, structured
// output, no tools except web search and fetch when allowed, no MCP servers
// and no saved session. The paper and questions go in on stdin.

async function run({ system, prompt, schema, model, effort, web }) {
  const claude = requireClaude();
  const tools = web ? "WebSearch,WebFetch" : "";
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--no-session-persistence",
    "--setting-sources", "user",
    "--strict-mcp-config",
    "--system-prompt", system,
    "--json-schema", JSON.stringify(schema),
    "--tools", tools,
    "--max-turns", web ? "40" : "8",
    ...(web ? ["--allowedTools", tools] : []),
    ...(model ? ["--model", model] : []),
    ...(effort ? ["--effort", effort] : []),
  ];
  // An empty folder, so no project's CLAUDE.md or settings apply.
  const cwd = await mkdtemp(join(tmpdir(), "paper-qa-"));
  try {
    await new Promise((resolve, reject) => {
      child = spawn(claude, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
      const toolNames = new Map(); // tool_use id -> name
      let chars = 0;
      let reported = 0;
      let stdout = "";
      let stderr = "";
      let result = null;

      const onEvent = (evt) => {
        if (evt.type === "system" && evt.subtype === "init") {
          send({ type: "model", model: evt.model });
        } else if (evt.type === "stream_event" && evt.event?.type === "content_block_delta") {
          const d = evt.event.delta ?? {};
          chars += (d.text ?? d.partial_json ?? "").length;
          if (chars - reported >= 500) {
            reported = chars;
            send({ type: "progress", chars });
          }
        } else if (evt.type === "assistant") {
          for (const block of evt.message?.content ?? []) {
            if (block.type !== "tool_use") continue;
            toolNames.set(block.id, block.name);
            if (block.name === "WebSearch") send({ type: "tool", name: "WebSearch", query: block.input?.query ?? "" });
            if (block.name === "WebFetch") {
              send({ type: "tool", name: "WebFetch", url: block.input?.url ?? "" });
              if (block.input?.url) send({ type: "sources", sources: [{ url: block.input.url, title: "" }] });
            }
          }
        } else if (evt.type === "user") {
          for (const block of evt.message?.content ?? []) {
            if (block.type === "tool_result" && toolNames.get(block.tool_use_id) === "WebSearch" && !block.is_error) {
              send({ type: "sources", sources: searchLinks(block.content) });
            }
          }
        } else if (evt.type === "result") {
          result = evt;
        }
      };

      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        let nl;
        while ((nl = stdout.indexOf("\n")) >= 0) {
          const line = stdout.slice(0, nl).trim();
          stdout = stdout.slice(nl + 1);
          if (!line) continue;
          try {
            onEvent(JSON.parse(line));
          } catch {
            /* not a JSON event */
          }
        }
      });
      child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-4000)));
      child.on("error", (e) => reject(new HostError("claude_code", `Couldn't start Claude Code: ${e.message}`)));
      child.on("close", (code) => {
        child = null;
        if (!result) {
          reject(new HostError("claude_code", `Claude Code exited (code ${code}) without a reply. ${stderr.trim()}`.trim()));
          return;
        }
        send({
          type: "result",
          isError: !!result.is_error,
          subtype: result.subtype,
          stopReason: result.stop_reason ?? null,
          structured: result.structured_output ?? null,
          text: typeof result.result === "string" ? result.result : "",
          errors: result.errors ?? [],
          usage: result.usage ?? {},
        });
        resolve();
      });
      child.stdin.on("error", () => {}); // claude may exit before reading everything
      child.stdin.end(prompt);
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

// WebSearch results list their links as JSON objects with a title and url.
function searchLinks(content) {
  const text = typeof content === "string" ? content : (content ?? []).map((b) => b.text ?? "").join("\n");
  const links = [];
  const pair = /"title"\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*"url"\s*:\s*("(?:[^"\\]|\\.)*")/g;
  for (const m of text.matchAll(pair)) {
    try {
      links.push({ title: JSON.parse(m[1]), url: JSON.parse(m[2]) });
    } catch {
      /* malformed escape */
    }
  }
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
    if (!links.some((l) => l.url === m[0])) links.push({ title: "", url: m[0] });
  }
  return links;
}

// ---------------------------------------------------------------------------
// Starting Claude Code on a new project

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const expandHome = (p) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

function slug(name) {
  const s = String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return s || "implementation";
}

async function launch({ dir, name, prompt, pdf }) {
  const claude = requireClaude();
  const base = expandHome(dir || "~/paper-qa-projects");
  await mkdir(base, { recursive: true });
  let folder;
  for (let n = 1; ; n++) {
    folder = join(base, n === 1 ? slug(name) : `${slug(name)}-${n}`);
    try {
      await mkdir(folder);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw new HostError("claude_code", `Couldn't create ${folder}: ${e.message}`);
    }
  }
  await writeFile(join(folder, "IMPLEMENTATION_PROMPT.md"), `${prompt}\n`);
  if (pdf) await writeFile(join(folder, "paper.pdf"), Buffer.from(pdf, "base64"));

  const script = join(await mkdtemp(join(tmpdir(), "paper-qa-start-")), "start-claude-code.command");
  await writeFile(
    script,
    `#!/bin/sh\ncd ${shellQuote(folder)} || exit 1\n${shellQuote(claude)} ${shellQuote(KICKOFF)}\nexec "\${SHELL:-/bin/sh}" -l\n`,
  );
  await chmod(script, 0o755);
  await openTerminal(script);
  send({ type: "launched", dir: folder });
}

const started = (cmd, args) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, { detached: true, stdio: "ignore" });
    p.on("spawn", () => {
      p.unref();
      resolve(true);
    });
    p.on("error", () => resolve(false));
  });

async function openTerminal(script) {
  if (process.env.PAPER_QA_TERMINAL) {
    if (await started(process.env.PAPER_QA_TERMINAL, [script])) return;
    throw new HostError("claude_code", `Couldn't start PAPER_QA_TERMINAL (${process.env.PAPER_QA_TERMINAL}).`);
  }
  if (process.platform === "darwin") {
    // Terminal runs .command files it is asked to open.
    if (await started("open", ["-a", "Terminal", script])) return;
  } else if (process.platform === "linux") {
    const candidates = [
      ["x-terminal-emulator", ["-e", script]],
      ["gnome-terminal", ["--", script]],
      ["konsole", ["-e", script]],
      ["xfce4-terminal", ["-x", script]],
      ["kitty", [script]],
      ["alacritty", ["-e", script]],
      ["xterm", ["-e", script]],
    ];
    for (const [cmd, args] of candidates) if (await started(cmd, args)) return;
  }
  throw new HostError("claude_code", `No terminal found to start Claude Code in. Run ${script} yourself, or set PAPER_QA_TERMINAL.`);
}
