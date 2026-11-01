// Tests the Claude Code helper (native-host/paper-qa-host.mjs) over the
// native messaging protocol, with tests/fake-claude.mjs standing in for
// Claude Code and a fake terminal, so nothing reaches the network.
//
//   npm run test:native-host

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ANSWER_SCHEMA } from "../shared/prompt.js";
import { IMPLEMENT_SCHEMA } from "../shared/implement.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = join(ROOT, "native-host/paper-qa-host.mjs");
const tmp = mkdtempSync(join(tmpdir(), "paper-qa-host-test-"));

const exe = (name, body) => {
  const path = join(tmp, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};
const claude = exe("claude", `exec "${process.execPath}" "${join(ROOT, "tests/fake-claude.mjs")}" "$@"`);
const terminalLog = join(tmp, "terminal.log");
const terminal = exe("terminal", `echo "$1" >> "${terminalLog}"`);
const claudeLog = join(tmp, "claude.log");
const replies = join(tmp, "replies.json");
writeFileSync(
  replies,
  JSON.stringify({
    answers: [{ question_index: 1, answerable: true, answer: "Yes.", quotes: [{ text: "A quote.", page: 1 }], web_sources: [] }],
    prompt: "# Goal\n\nBuild it.",
    web_sources: [{ url: "https://github.com/KaimingHe/deep-residual-networks", title: "Code" }],
  }),
);
const env = { ...process.env, CLAUDE_PATH: claude, PAPER_QA_TERMINAL: terminal, FAKE_CLAUDE_LOG: claudeLog, FAKE_CLAUDE_REPLIES: replies };

/** Starts the host, sends one message, and collects replies until a final one. */
function call(message) {
  return new Promise((resolve, reject) => {
    const host = spawn(process.execPath, [HOST, "chrome-extension://test/"], { env });
    const replies = [];
    let buf = Buffer.alloc(0);
    host.stdout.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
        const msg = JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString());
        buf = buf.subarray(4 + buf.readUInt32LE(0));
        replies.push(msg);
        if (["result", "pong", "launched", "error"].includes(msg.type)) {
          host.stdin.end();
          resolve(replies);
        }
      }
    });
    host.on("error", reject);
    host.on("close", (code) => resolve(replies));
    const body = Buffer.from(JSON.stringify(message));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    host.stdin.write(Buffer.concat([head, body]));
  });
}
const lastRun = () => JSON.parse(readFileSync(claudeLog, "utf8").trim().split("\n").at(-1));
const arg = (args, name) => args[args.indexOf(name) + 1];

let failed = false;
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failed = true;
    console.log(`✗ ${name}\n  ${e.message.split("\n").join("\n  ")}`);
  }
};

try {
  await step("ping reports where Claude Code is and its version", async () => {
    const [pong] = await call({ type: "ping" });
    assert.deepEqual(pong, { type: "pong", host: 1, claude, version: "9.9.9 (Claude Code)" });
  });

  await step("a run sends the paper on stdin with no tools and returns the structured output", async () => {
    const replies = await call({
      type: "run",
      system: "You answer questions.",
      prompt: "<paper>…</paper>\n\nQuestions:\n1. Why?",
      schema: ANSWER_SCHEMA,
      model: "claude-sonnet-5-5",
      effort: "low",
      web: false,
    });
    const result = replies.at(-1);
    assert.equal(result.type, "result");
    assert.equal(result.isError, false);
    assert.equal(result.structured.answers[0].answer, "Yes.");
    assert.deepEqual(replies[0], { type: "model", model: "claude-sonnet-5-5" });
    const { args, stdin } = lastRun();
    assert.equal(stdin, "<paper>…</paper>\n\nQuestions:\n1. Why?");
    assert.ok(args.includes("-p") && args.includes("--no-session-persistence") && args.includes("--strict-mcp-config"));
    assert.equal(arg(args, "--output-format"), "stream-json");
    assert.equal(arg(args, "--system-prompt"), "You answer questions.");
    assert.deepEqual(JSON.parse(arg(args, "--json-schema")), ANSWER_SCHEMA);
    assert.equal(arg(args, "--tools"), "", "no tools without the web");
    assert.equal(args.includes("--allowedTools"), false);
    assert.equal(arg(args, "--model"), "claude-sonnet-5-5");
    assert.equal(arg(args, "--effort"), "low");
  });

  await step("a web run allows only WebSearch and WebFetch and reports the pages found", async () => {
    const replies = await call({ type: "run", system: "s", prompt: "p", schema: IMPLEMENT_SCHEMA, web: true });
    const { args } = lastRun();
    assert.equal(arg(args, "--tools"), "WebSearch,WebFetch");
    assert.equal(arg(args, "--allowedTools"), "WebSearch,WebFetch");
    assert.deepEqual(
      replies.filter((m) => m.type === "tool").map((m) => m.name),
      ["WebSearch", "WebFetch"],
    );
    const sources = replies.filter((m) => m.type === "sources").flatMap((m) => m.sources.map((s) => s.url));
    assert.deepEqual(sources, [
      "https://github.com/KaimingHe/deep-residual-networks",
      "https://github.com/KaimingHe/deep-residual-networks/blob/master/README.md",
    ]);
    assert.equal(replies.at(-1).structured.prompt, "# Goal\n\nBuild it.");
  });

  await step("Claude Code's login error comes back as an error result", async () => {
    const result = (await call({ type: "run", system: "s", prompt: "FAKE_NOT_LOGGED_IN", schema: ANSWER_SCHEMA })).at(-1);
    assert.equal(result.type, "result");
    assert.equal(result.isError, true);
    assert.match(result.text, /Not logged in/);
  });

  await step("launch creates a project with the prompt and paper and opens a terminal on it", async () => {
    const projects = join(tmp, "projects");
    const pdf = Buffer.from("%PDF-1.4 fake").toString("base64");
    const launch = { type: "launch", dir: projects, name: "Residual networks for CIFAR-10", prompt: "# Goal", pdf };
    const [first] = await call(launch);
    const [second] = await call(launch);
    assert.deepEqual(first, { type: "launched", dir: join(projects, "residual-networks-for-cifar-10") });
    assert.equal(second.dir, join(projects, "residual-networks-for-cifar-10-2"), "an existing project must not be reused");
    assert.deepEqual(readdirSync(first.dir).sort(), ["IMPLEMENTATION_PROMPT.md", "paper.pdf"]);
    assert.equal(readFileSync(join(first.dir, "IMPLEMENTATION_PROMPT.md"), "utf8"), "# Goal\n");
    assert.equal(readFileSync(join(first.dir, "paper.pdf"), "utf8"), "%PDF-1.4 fake");
    // The terminal is started detached, so it may not have run yet.
    const logged = () => (existsSync(terminalLog) ? readFileSync(terminalLog, "utf8").trim().split("\n") : []);
    for (let i = 0; i < 50 && logged().length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    const scripts = logged();
    assert.equal(scripts.length, 2);
    // Either terminal may have logged first.
    const script = scripts.map((s) => readFileSync(s, "utf8")).find((s) => s.includes(`cd '${first.dir}' ||`));
    assert.ok(script, "no terminal was opened on the first project");
    assert.match(script, new RegExp(`'${claude}' 'Read IMPLEMENTATION_PROMPT\\.md and carry it out\\.`));
  });

  await step("a missing Claude Code is reported", async () => {
    const saved = env.CLAUDE_PATH;
    env.CLAUDE_PATH = join(tmp, "nope");
    env.PATH = "/usr/bin:/bin";
    env.HOME = tmp;
    try {
      const [pong] = await call({ type: "ping" });
      assert.equal(pong.claude, null);
      const [err] = await call({ type: "run", system: "s", prompt: "p", schema: ANSWER_SCHEMA });
      assert.equal(err.type, "error");
      assert.equal(err.code, "claude_code_missing");
    } finally {
      env.CLAUDE_PATH = saved;
      env.PATH = process.env.PATH;
      env.HOME = process.env.HOME;
    }
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
assert.ok(!existsSync(tmp));
process.exit(failed ? 1 : 0);
